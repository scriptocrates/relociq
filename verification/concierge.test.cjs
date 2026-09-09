// verification/concierge.test.cjs
//
// Concierge authentication contract tests.
// Uses a real RSA-2048 key pair and real JWT signing — no signature mocking.
// Asserts that rejected requests never reach Anthropic.

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync, createSign, createPublicKey } = require('node:crypto');
const { handler } = require('../netlify/functions/concierge');

// ── Test key pair (generated once; ~150ms) ──────────────────────────────────
const { privateKey: TEST_PRIV, publicKey: TEST_PUB } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
// A second key pair to test forged-signature rejection
const { privateKey: OTHER_PRIV } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const TEST_KID = 'test-key-1';
const TEST_JWK = { ...createPublicKey(TEST_PUB).export({ format: 'jwk' }), kid: TEST_KID, use: 'sig', alg: 'RS256' };
const MOCK_JWKS = { keys: [TEST_JWK] };

const JWKS_URL = 'https://test.clerk.dev/.well-known/jwks.json';
const ISSUER = 'https://test.clerk.dev'; // matches jwksUrl.replace(/.well-known\/jwks.json/, '')
const PRO_USER = 'user_pro123testonly';
const FREE_USER = 'user_free456testonly';

// ── JWT helpers ──────────────────────────────────────────────────────────────
function signJwt(payload, privKey = TEST_PRIV, headerOverrides = {}) {
  const header = { alg: 'RS256', kid: TEST_KID, ...headerOverrides };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(h + '.' + p);
  return h + '.' + p + '.' + signer.sign(privKey, 'base64url');
}

function validPayload(sub = PRO_USER, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { sub, iss: ISSUER, azp: 'https://relociq.app', exp: now + 300, nbf: now - 5, iat: now - 5, sid: 'sess_test', ...overrides };
}

// ── Anthropic mock response ──────────────────────────────────────────────────
const GOOD_ANTHROPIC = {
  stop_reason: 'tool_use',
  usage: { input_tokens: 50, output_tokens: 30 },
  content: [{ type: 'tool_use', name: 'respond', input: { reply: 'Test reply.', suggested_followups: [] } }]
};

// ── Event builder ────────────────────────────────────────────────────────────
function event(token, bodyOverrides = {}) {
  return {
    httpMethod: 'POST',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: JSON.stringify({
      corridor: 'IN-DE',
      message: 'How long does this take?',
      history: [],
      stepsData: null,
      pathwaySummary: '',
      ...bodyOverrides
    })
  };
}

// ── Mock fetch factory ───────────────────────────────────────────────────────
// Returns a getter for the Anthropic call count (to assert it was/wasn't called).
function mockFetch({ jwks = MOCK_JWKS, proUsers = [PRO_USER] } = {}) {
  let anthropicCalls = 0;
  global.fetch = async (url) => {
    if (url.includes('.well-known/jwks.json')) {
      return { ok: true, json: async () => jwks };
    }
    if (url.includes('api.clerk.com/v1/users')) {
      const userId = url.split('/').pop();
      return { ok: true, json: async () => ({ public_metadata: { pro: proUsers.includes(userId) } }) };
    }
    if (url.includes('api.anthropic.com')) {
      anthropicCalls++;
      return { ok: true, json: async () => GOOD_ANTHROPIC };
    }
    throw new Error('Unexpected fetch: ' + url);
  };
  return () => anthropicCalls;
}

// ── Env helpers ──────────────────────────────────────────────────────────────
function setEnv(overrides = {}) {
  const defaults = {
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    CLERK_SECRET_KEY: 'test-clerk-secret',
    CLERK_JWKS_URL: JWKS_URL
  };
  Object.assign(process.env, defaults, overrides);
}
function clearEnv() {
  for (const k of ['ANTHROPIC_API_KEY', 'CLERK_SECRET_KEY', 'CLERK_JWKS_URL', 'CLERK_AUTHORIZED_PARTY']) {
    delete process.env[k];
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────
test('concierge authentication contracts', async t => {
  const origFetch = global.fetch;
  try {

    await t.test('missing CLERK_SECRET_KEY → 503, Anthropic never called', async () => {
      setEnv({ CLERK_SECRET_KEY: undefined });
      delete process.env.CLERK_SECRET_KEY;
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload())));
      assert.equal(r.statusCode, 503);
      assert.equal(calls(), 0, 'Anthropic must not be called');
      clearEnv();
    });

    await t.test('missing CLERK_JWKS_URL → 503, Anthropic never called', async () => {
      setEnv({ CLERK_JWKS_URL: undefined });
      delete process.env.CLERK_JWKS_URL;
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload())));
      assert.equal(r.statusCode, 503);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('missing Authorization header → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const r = await handler(event(null)); // no token
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('empty Bearer token → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      // Manually craft event with empty Bearer
      const r = await handler({ httpMethod: 'POST', headers: { authorization: 'Bearer ' }, body: JSON.stringify({ corridor: 'IN-DE', message: 'hi', history: [] }) });
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('expired token (exp in past) → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const now = Math.floor(Date.now() / 1000);
      const r = await handler(event(signJwt(validPayload(PRO_USER, { exp: now - 60 }))));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('future nbf (> 60s clock-skew allowance) → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const now = Math.floor(Date.now() / 1000);
      const r = await handler(event(signJwt(validPayload(PRO_USER, { nbf: now + 120 }))));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('wrong issuer → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload(PRO_USER, { iss: 'https://evil.clerk.dev' }))));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('forged signature (signed with different key) → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload(), OTHER_PRIV)));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('non-RS256 algorithm in header → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      // HS256 header but signed with RSA — algorithm check should reject before signature
      const r = await handler(event(signJwt(validPayload(), TEST_PRIV, { alg: 'HS256' })));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('kid not in JWKS → 401, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload(), TEST_PRIV, { kid: 'unknown-kid-xyz' })));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('CLERK_AUTHORIZED_PARTY set, wrong azp in token → 401', async () => {
      setEnv({ CLERK_AUTHORIZED_PARTY: 'https://relociq.app' });
      const calls = mockFetch();
      const r = await handler(event(signJwt(validPayload(PRO_USER, { azp: 'https://evil.example.com' }))));
      assert.equal(r.statusCode, 401);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('valid JWT, non-Pro user → 403, Anthropic never called', async () => {
      setEnv();
      const calls = mockFetch({ proUsers: [] }); // nobody is Pro
      const r = await handler(event(signJwt(validPayload(FREE_USER))));
      assert.equal(r.statusCode, 403);
      assert.equal(calls(), 0);
      clearEnv();
    });

    await t.test('valid Pro user with correct azp → 200, Anthropic called once', async () => {
      setEnv({ CLERK_AUTHORIZED_PARTY: 'https://relociq.app' });
      const calls = mockFetch({ proUsers: [PRO_USER] });
      const r = await handler(event(signJwt(validPayload(PRO_USER, { azp: 'https://relociq.app' }))));
      assert.equal(r.statusCode, 200);
      assert.equal(calls(), 1, 'Anthropic must be called exactly once for valid Pro user');
      const body = JSON.parse(r.body);
      assert.ok(body.reply, 'response must include reply');
      clearEnv();
    });

    await t.test('valid Pro user, no CLERK_AUTHORIZED_PARTY set → 200 (azp not enforced)', async () => {
      setEnv(); // no CLERK_AUTHORIZED_PARTY
      const calls = mockFetch({ proUsers: [PRO_USER] });
      const r = await handler(event(signJwt(validPayload(PRO_USER))));
      assert.equal(r.statusCode, 200);
      assert.equal(calls(), 1);
      clearEnv();
    });

  } finally {
    global.fetch = origFetch;
    clearEnv();
  }
});
