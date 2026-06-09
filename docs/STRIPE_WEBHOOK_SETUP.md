# Stripe → Clerk Pro-Sync Setup

This wires up server-side Pro tracking so the paywall actually holds. Without this, anyone can paste `?welcome=pro` in the URL or run `localStorage.setItem('relociq_pro','1')` in dev tools to bypass payment.

## What this fixes

**Before:** Pro flag lived in localStorage. Tamperable in 5 seconds. No server record of who paid. No cross-device sync.

**After:** Stripe webhook fires when a customer pays → updates `user.publicMetadata.pro = true` in Clerk → frontend reads from Clerk session. Tamperable only by paying.

## Architecture

```
User clicks "Start trial"
  ↓
handleProUpgrade() appends ?client_reference_id={clerk_user_id} to Stripe Payment Link
  ↓
User pays at buy.stripe.com → redirected to relociq.app/?welcome=pro
  ↓
[in parallel] Stripe fires checkout.session.completed webhook → Netlify Function
  ↓
Netlify Function reads client_reference_id, calls Clerk API to set publicMetadata.pro = true
  ↓
Frontend polls Clerk.user.reload() every 2s — when pro=true appears, shows welcome banner
```

## Setup steps

### 1. Deploy `stripe-webhook.js` to Netlify

Create the file at `netlify/functions/stripe-webhook.js` in your repo. The function uses Node's built-in `crypto` and global `fetch` — no npm dependencies.

If your repo doesn't have a `netlify/functions/` folder yet, just create it. Add a minimal `netlify.toml` at the repo root if you don't have one:

```toml
[build]
  publish = "."
  functions = "netlify/functions"
```

Connect the repo to a Netlify project (or migrate from GitHub Pages — Netlify can deploy the static site too). Deploying gives you a function URL like `https://relociq.netlify.app/.netlify/functions/stripe-webhook`.

### 2. Set environment variables in Netlify

In Netlify project → Site configuration → Environment variables, add:

| Key | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe Dashboard → Developers → API keys → Secret key. Use **test mode key** (`sk_test_...`) while testing, swap to live (`sk_live_...`) when you flip Stripe to live mode. |
| `STRIPE_WEBHOOK_SECRET` | Created in step 3 below. Set this AFTER creating the webhook endpoint. |
| `CLERK_SECRET_KEY` | Clerk Dashboard → API keys → Secret keys. Copy the secret key (starts with `sk_test_` or `sk_live_`). |

### 3. Create the Stripe webhook endpoint

Stripe Dashboard → Developers → Webhooks → Add endpoint.

- **Endpoint URL:** `https://your-site.netlify.app/.netlify/functions/stripe-webhook` (the function URL from step 1)
- **Events to send:**
  - `checkout.session.completed`
  - `customer.subscription.deleted`
  - `customer.subscription.updated`

Save. Stripe shows the **Signing secret** (starts with `whsec_...`) — copy this and set it as `STRIPE_WEBHOOK_SECRET` in Netlify env vars.

### 4. Test in test mode

1. Sign in to relociq.app with a test account
2. Click "Start 14-day free trial"
3. Pay with test card `4242 4242 4242 4242`, any future expiry, any CVC, any zip
4. After redirect to `relociq.app/?welcome=pro`, you'll see the "Activating your Pro subscription..." banner
5. Within 1–5 seconds it should flip to the green welcome banner once the webhook fires
6. Verify in Clerk Dashboard → Users → click your test user → Public metadata should show `{ "pro": true, "stripe_subscription_id": "sub_...", ... }`

If the webhook doesn't fire:
- Check Netlify → Logs → Functions → stripe-webhook for errors
- Check Stripe Dashboard → Developers → Webhooks → your endpoint → "Sent events" tab — Stripe will retry failed events automatically up to 3 days, but the first attempt failing usually means a config issue

### 5. Flip to live mode (when you're ready to accept real money)

- Get your živnostenský list first
- Activate Stripe live mode (Stripe will need your business details, ID verification)
- Create a new Payment Link in live mode (you'll get a new `plink_live_...` ID)
- Update `STRIPE_PAYMENT_LINK` constant in `index.html` to the live URL
- Update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Netlify to live versions
- Create a new webhook endpoint in Stripe live mode (you'll get a new `whsec_...`)

## What you still need to do on the frontend

The frontend patches are already in `index.html`:
- `handleProUpgrade` passes `client_reference_id` and `prefilled_email` to Stripe
- `checkProStatus` reads from `window.Clerk.user.publicMetadata.pro`
- Polling logic waits up to 40s for the webhook to sync after redirect
- Legacy `localStorage.relociq_pro` is now cleaned up on every Pro check

Nothing else to change. Just deploy the function and set the env vars.

## Failure modes & how the code handles them

| Scenario | What happens |
|---|---|
| User pastes `?welcome=pro` without paying | Banner shows "Activating...", polls Clerk 20 times over 40s, finds no Pro flag, shows "Payment received — Pro is taking a moment to activate" message (slightly misleading but no Pro access granted). |
| User runs `localStorage.setItem('relociq_pro','1')` | Ignored. The next `checkProStatus()` call wipes the legacy key. Pro state comes from Clerk metadata only. |
| Webhook fails to fire (Netlify down, signature mismatch) | Stripe retries automatically for up to 3 days. User sees the timeout message. They get a Stripe email receipt regardless, so you can manually grant Pro in Clerk Dashboard if needed. |
| User signs out then back in | Pro state restored from Clerk metadata. localStorage cleared on signout but doesn't matter. |
| User cancels subscription in Stripe Customer Portal | Stripe fires `customer.subscription.deleted` → webhook calls Clerk → publicMetadata.pro = false. Next page load they're back on the free tier. |

## Future improvements (not blockers)

- **Customer Portal link** — currently no way for users to manage their own subscription. Add a "Manage subscription" link that creates a Stripe Customer Portal session via a separate Netlify Function.
- **Trial-ending warning** — handle `customer.subscription.trial_will_end` to send users a heads-up email 3 days before they're charged.
- **Manual Pro grant** — for refunds, comp accounts, or webhook recovery, you can manually set `publicMetadata.pro = true` for any user in the Clerk Dashboard.
