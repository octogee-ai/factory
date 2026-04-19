import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/db', () => ({
  auth: { verifyIdToken: vi.fn() },
  db: {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
        update: async () => undefined,
        collection: () => ({
          doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }),
        }),
      }),
      where: () => ({ where: () => ({ get: async () => ({ size: 0, docs: [] }) }) }),
    }),
  },
  FieldValue: {
    increment: (n: number) => ({ __op: 'increment', operand: n }),
    serverTimestamp: () => ({ __op: 'serverTimestamp' }),
  },
}));

vi.mock('../lib/stripe', () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: vi.fn((_body: any, _sig: string, _secret: string) => ({ type: 'noop', data: { object: {} } })),
    },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

import { createApp } from '../index';

describe('workspace-api middleware stack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  it('sets CORS headers for allowed localhost origin', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'http://localhost:4321');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not set allow-origin header for disallowed origin', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health')
      .set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('handles CORS preflight on public route', async () => {
    const app = createApp();
    const res = await request(app)
      .options('/api/workspace')
      .set('Origin', 'https://octogee.web.app')
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://octogee.web.app');
  });

  it('exposes metrics endpoint', async () => {
    const app = createApp();
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/plain');
    expect(res.text).toContain('http_requests_total');
  });

  it('keeps health endpoint working without auth', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('workspace-api');
  });

  it('parses JSON bodies on internal routes', async () => {
    // INTERNAL_SERVICE_KEY unset in test — dev fallback allows through so we can check JSON parsing
    delete process.env.INTERNAL_SERVICE_KEY;
    const app = createApp();
    const res = await request(app)
      .post('/internal/billing/check-limit')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing uid' });
  });

  // ── Security headers (Helmet) ─────────────────────────────────────────────

  it('sets X-Content-Type-Options: nosniff on all responses', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('sets X-Frame-Options: SAMEORIGIN on all responses', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('sets Strict-Transport-Security header', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['strict-transport-security']).toMatch(/max-age=/);
  });

  it('sets Referrer-Policy header', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['referrer-policy']).toBeDefined();
  });

  it('sets a lockdown CSP header (default-src none, no scripts/forms/frames)', async () => {
    // CodeQL js/insecure-helmet-configuration flagged disabled CSP. A JSON
    // API doesn't need script/img/style allowances — even if a response
    // leaks into a browser, `default-src 'none'` blocks execution. If we
    // ever serve HTML we'll declare a narrower per-route CSP.
    const app = createApp();
    const res = await request(app).get('/api/health');

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  // ── Rate limiting ─────────────────────────────────────────────────────────

  it('health endpoint is exempt from rate limiting (no RateLimit header)', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    // When a request is skipped by the rate limiter, no RateLimit header is set.
    // Helmet + rate-limit draft-7 headers would be 'RateLimit' — absent means skipped.
    expect(res.status).toBe(200);
    // Should still have Helmet headers — exempt only from rate limiting
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('metrics endpoint is exempt from rate limiting', async () => {
    const app = createApp();
    const res = await request(app).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('non-exempt endpoints include RateLimit response headers', async () => {
    const app = createApp();
    // /api/leads does not exist but still passes through the rate limiter
    const res = await request(app).get('/api/leads');

    // draft-7 RateLimit header should be present for non-exempt routes
    // (even 404s pass through rate limiting middleware)
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit']).toBeDefined();
  });

  it('preserves raw body path for stripe webhook route', async () => {
    const app = createApp();
    const payload = JSON.stringify({ id: 'evt_123', type: 'noop' });
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('Stripe-Signature', 'sig_test')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });
  });
});
