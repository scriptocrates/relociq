# Relociq repair regression tests

Node + jsdom. No test framework — plain scripts, exit code 1 on failure.

## Run

```bash
npm install jsdom
node tests/test_recommender.js   # 30 assertions
node tests/test_costs.js         # 26 assertions
```

Both scripts read `index.html` from a hard-coded path near the top
(`/tmp/repair/work.html`). Change that to your local `index.html` before running.

## What they cover

**test_recommender.js**
- The brief's exact failing profile (India / software engineer / USD 40,000 /
  English / career growth + easy visa) renders without exception.
- Untrusted model output renders inertly: script/img/iframe/svg payloads
  produce zero corresponding elements and surface as literal text.
- 11 malformed-response shapes (null, wrong types, missing fields,
  unsupported destination, out-of-range score) each recover safely.
- Empty results produce a recovery message, not a blank panel.
- Submit hardening present: duplicate guard, AbortController timeout,
  stale-response sequence guard, per-stage error differentiation,
  no personal form data in logs.

**test_costs.js**
- The three routes named in the brief no longer show "visa fees only".
- Systemic sweep: 0 of 322 routes claim a visa fee on a no-visa route.
- Zero/missing/null/string/negative cost values handled without exception
  and rendered as "—" rather than "EUR 0".
- Stale-result invalidation wired into `select()`.
- Removed claims stay removed; stated coverage matches the data.

## Not covered

These are mocked-fixture tests. They do not exercise the live Anthropic API,
the deployed Netlify functions, Clerk auth, or Stripe. No live smoke test was
run from this environment — outbound network is restricted to a fixed allowlist
that excludes relociq.app.
