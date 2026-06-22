// netlify/functions/stripe-webhook.js
//
// Stripe → Clerk Pro-flag bridge.
//
// On checkout.session.completed (paid/no_payment_required): sets clerk.user.publicMetadata.pro = true
// On checkout.session.async_payment_succeeded: same as above, for BACS/SEPA/ACH/bank-transfer customers
// On customer.subscription.deleted: sets pro = false
// On customer.subscription.updated: syncs status (active/trialing → pro=true, anything else → pro=false)
//
// Required environment variables (set in Netlify project settings → Environment):
//   STRIPE_SECRET_KEY        — sk_live_... (or sk_test_... for test mode)
//   STRIPE_WEBHOOK_SECRET    — whsec_...  (from Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret)
//   CLERK_SECRET_KEY         — sk_live_... or sk_test_... (from Clerk Dashboard → API Keys → Secret keys)
//
// No npm dependencies — uses Node's built-in crypto module for HMAC and global fetch.

const crypto = require('crypto');

exports.handler = async function (event) {
  // Fail fast if env vars are missing rather than throwing cryptic errors later
  if (!process.env.STRIPE_WEBHOOK_SECRET || !process.env.CLERK_SECRET_KEY || !process.env.STRIPE_SECRET_KEY) {
    console.error('Missing required environment variables (STRIPE_WEBHOOK_SECRET, CLERK_SECRET_KEY, STRIPE_SECRET_KEY)');
    return { statusCode: 500, body: 'Server misconfiguration' };
  }

  // Stripe webhooks are always POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sigHeader = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const body = event.body;

  // 1. Verify Stripe signature — rejects forged requests
  if (!verifyStripeSignature(body, sigHeader, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.warn('Invalid Stripe signature');
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try {
    evt = JSON.parse(body);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  try {
    switch (evt.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(evt.data.object);
        break;
      // Fires for BACS, SEPA, ACH, bank transfer — payment settles after checkout completes
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(evt.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(evt.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(evt.data.object);
        break;
      default:
        // Ignore unhandled event types — return 200 so Stripe doesn't retry
        console.log('Unhandled event type:', evt.type);
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Return 500 so Stripe retries (transient failures recover automatically)
    return { statusCode: 500, body: 'Internal error' };
  }
};

// ─── Signature verification ───
function verifyStripeSignature(body, sigHeader, secret) {
  if (!sigHeader || !secret) return false;

  // Collect all t= and v1= values — Stripe sends multiple v1= during secret rotation
  let timestamp = null;
  const signatures = [];
  sigHeader.split(',').forEach(p => {
    const eq = p.indexOf('=');
    if (eq === -1) return;
    const k = p.slice(0, eq).trim();
    const v = p.slice(eq + 1).trim();
    if (k === 't' && timestamp === null) timestamp = v;
    if (k === 'v1') signatures.push(v);
  });

  if (!timestamp || signatures.length === 0) return false;

  // Reject events older than 5 minutes (replay protection), and future-dated events (clock skew)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Number.isNaN(age) || age < 0 || age > 300) return false;

  const payload = `${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  // Accept if ANY signature matches (covers rotation window)
  return signatures.some(sig => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), expectedBuf);
    } catch (_) {
      return false;
    }
  });
}

// ─── Clerk user ID validation ───
function isValidClerkUserId(id) {
  return typeof id === 'string' && /^user_[a-zA-Z0-9]+$/.test(id);
}

// ─── Event handlers ───
async function handleCheckoutCompleted(session) {
  const clerkUserId = session.client_reference_id;
  const stripeCustomerId = session.customer;
  const stripeSubId = session.subscription;

  if (!clerkUserId) {
    console.warn('checkout event without client_reference_id', session.id);
    return;
  }

  // Validate format before use in API URL (prevents path traversal)
  if (!isValidClerkUserId(clerkUserId)) {
    console.warn('checkout event with invalid client_reference_id format', session.id);
    return;
  }

  // For checkout.session.completed: only grant Pro when payment is confirmed.
  // async_payment_succeeded events always represent a successful payment so this check is safe for both.
  if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
    console.warn('checkout completed but payment not confirmed:', session.id, session.payment_status);
    return;
  }

  // Grant Pro and tag the Stripe customer in parallel — the two writes are independent.
  // If the Stripe tag fails we log a warning (Pro is still granted) rather than throwing
  // and triggering a Stripe retry that would re-grant already-active Pro.
  const clerkWrite = updateClerkUserPro(clerkUserId, true, {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubId,
    subscribed_at: new Date().toISOString()
  });

  const stripeTag = stripeCustomerId
    ? updateStripeCustomerMetadata(stripeCustomerId, { clerk_user_id: clerkUserId })
    : Promise.resolve();

  const [clerkResult, stripeResult] = await Promise.allSettled([clerkWrite, stripeTag]);

  if (clerkResult.status === 'rejected') {
    // Re-throw so Stripe retries — Pro has not been granted yet
    throw clerkResult.reason;
  }
  if (stripeResult.status === 'rejected') {
    // Log and continue — Pro is granted; the missing tag means future sub events may
    // not resolve this user, but that is preferable to denying access to a paying customer
    console.warn('Stripe customer tag failed for', stripeCustomerId, '—', stripeResult.reason.message);
  }

  console.log(`Granted Pro to Clerk user ${clerkUserId} (sub ${stripeSubId})`);
}

async function handleSubscriptionDeleted(subscription) {
  const clerkUserId = await resolveClerkUserIdFromCustomer(subscription.customer);
  if (!clerkUserId) {
    console.warn('subscription.deleted with no resolvable clerk_user_id', subscription.id);
    return;
  }
  await updateClerkUserPro(clerkUserId, false, {
    canceled_at: new Date().toISOString(),
    last_subscription_id: subscription.id
  });
  console.log(`Revoked Pro from Clerk user ${clerkUserId}`);
}

async function handleSubscriptionUpdated(subscription) {
  const clerkUserId = await resolveClerkUserIdFromCustomer(subscription.customer);
  if (!clerkUserId) return;

  // Active states keep Pro on; everything else turns it off
  const activeStates = ['active', 'trialing'];
  const isActive = activeStates.includes(subscription.status);

  await updateClerkUserPro(clerkUserId, isActive, {
    subscription_status: subscription.status,
    last_status_update: new Date().toISOString()
  });
  console.log(`Updated Pro=${isActive} for ${clerkUserId} (status: ${subscription.status})`);
}

// ─── Clerk API ───
async function updateClerkUserPro(userId, pro, extraMetadata) {
  const res = await fetch(`https://api.clerk.com/v1/users/${userId}/metadata`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${process.env.CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      public_metadata: { pro, ...extraMetadata }
    })
  });
  if (!res.ok) {
    // Don't include the response body — it may contain user-identifying fields
    throw new Error(`Clerk metadata update failed (${res.status})`);
  }
}

// ─── Stripe API ───
async function resolveClerkUserIdFromCustomer(customerId) {
  if (!customerId) return null;
  const customer = await getStripeCustomer(customerId);
  if (!customer) return null;
  const id = customer.metadata && customer.metadata.clerk_user_id;
  // Validate before use in API URL — same guard as the checkout path
  if (!isValidClerkUserId(id)) {
    if (id) console.warn('clerk_user_id in Stripe metadata failed validation:', customerId);
    return null;
  }
  return id;
}

async function getStripeCustomer(customerId) {
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  // 404 means the customer was hard-deleted — treat as unresolvable rather than throwing
  // (throwing would cause Stripe to retry and eventually permanently drop the event)
  if (res.status === 404) {
    console.warn('Stripe customer not found (hard-deleted?):', customerId);
    return null;
  }
  if (!res.ok) throw new Error(`Stripe customer fetch failed (${res.status})`);
  return res.json();
}

async function updateStripeCustomerMetadata(customerId, metadata) {
  const form = new URLSearchParams();
  Object.entries(metadata).forEach(([k, v]) => {
    if (v !== null && v !== undefined) form.append(`metadata[${k}]`, String(v));
  });
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: form.toString()
  });
  if (!res.ok) {
    throw new Error(`Stripe customer metadata update failed (${res.status})`);
  }
}
