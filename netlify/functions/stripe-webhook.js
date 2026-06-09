// netlify/functions/stripe-webhook.js
//
// Stripe → Clerk Pro-flag bridge.
//
// On checkout.session.completed: sets clerk.user.publicMetadata.pro = true
// On customer.subscription.deleted / canceled: sets pro = false
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
    console.error('Webhook handler error:', err);
    // Return 500 so Stripe retries (transient failures recover automatically)
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// ─── Signature verification ───
function verifyStripeSignature(body, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  sigHeader.split(',').forEach(p => {
    const [k, v] = p.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  });
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject events older than 5 minutes (replay protection)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (Number.isNaN(age) || age > 300) return false;

  const payload = `${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch (_) {
    return false;
  }
}

// ─── Event handlers ───
async function handleCheckoutCompleted(session) {
  const clerkUserId = session.client_reference_id;
  const stripeCustomerId = session.customer;
  const stripeSubId = session.subscription;

  if (!clerkUserId) {
    console.warn('checkout.session.completed without client_reference_id', session.id);
    return;
  }

  // 1. Grant Pro on the Clerk user
  await updateClerkUserPro(clerkUserId, true, {
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: stripeSubId,
    subscribed_at: new Date().toISOString()
  });

  // 2. Tag the Stripe customer with clerk_user_id so subsequent events can find them
  if (stripeCustomerId) {
    await updateStripeCustomerMetadata(stripeCustomerId, { clerk_user_id: clerkUserId });
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
    const text = await res.text();
    throw new Error(`Clerk metadata update failed (${res.status}): ${text}`);
  }
}

// ─── Stripe API ───
async function resolveClerkUserIdFromCustomer(customerId) {
  if (!customerId) return null;
  const customer = await getStripeCustomer(customerId);
  return customer && customer.metadata ? customer.metadata.clerk_user_id : null;
}

async function getStripeCustomer(customerId) {
  const res = await fetch(`https://api.stripe.com/v1/customers/${customerId}`, {
    headers: { 'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
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
    const text = await res.text();
    throw new Error(`Stripe customer metadata update failed (${res.status}): ${text}`);
  }
}
