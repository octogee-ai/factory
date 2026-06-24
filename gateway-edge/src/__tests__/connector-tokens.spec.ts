import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const firestoreData: Record<string, Record<string, unknown>> = {};
const docWrites: { path: string; data: unknown; merge?: boolean }[] = [];

vi.mock('../lib/db', () => ({
  db: {
    doc: (path: string) => ({
      get: async () => {
        const data = firestoreData[path];
        return { exists: !!data, data: () => data };
      },
      set: async (data: unknown, opts?: { merge?: boolean }) => {
        docWrites.push({ path, data, merge: opts?.merge });
      },
    }),
  },
}));

vi.mock('../lib/kms', () => ({
  decryptSecret: vi.fn(async (enc: string) => {
    if (!enc.startsWith('ENC:')) throw new Error('mock decrypt: bad ciphertext');
    return enc.slice(4);
  }),
  encryptSecret: vi.fn(async (plain: string) => `ENC:${plain}`),
}));

vi.mock('../lib/internal-fetch', () => ({
  internalFetch: vi.fn(),
}));

import {
  readConnectorAccessToken,
  readConnectorClientCreds,
  getFreshAccessToken,
} from '../lib/connector-tokens.js';
import { getConnector } from '../lib/connectors/index.js';
import { decryptSecret } from '../lib/kms.js';
import { internalFetch } from '../lib/internal-fetch.js';

beforeEach(() => {
  for (const k of Object.keys(firestoreData)) delete firestoreData[k];
  docWrites.length = 0;
  vi.mocked(decryptSecret).mockClear();
  vi.mocked(internalFetch).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  delete process.env.CONNECTOR_TOKEN_BROKER_URL;
  delete process.env.GATEWAY_ID;
  delete process.env.CONNECTOR_TOKEN_AUTHORITY;
});

describe('readConnectorAccessToken', () => {
  it('fails closed when CONNECTOR_TOKEN_BROKER_URL is unset', async () => {
    firestoreData['users/u-alice/secrets/github'] = {
      provider: 'github',
      tokens: { encryptedAccessToken: 'ENC:gho_plain', encryptedRefreshToken: null },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is required',
    );
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('fails closed when the broker is configured without GATEWAY_ID', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing',
    );
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('uses the connector token broker, avoiding local Firestore and KMS', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_brokered');

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/access-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ gatewayId: 'default', uid: 'u-alice', connectorId: 'github' }),
      }),
      expect.any(Object),
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('returns null when the broker returns 404', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    vi.mocked(internalFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }));

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('propagates broker failures without local fallback', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-token-must-not-be-used' },
    };
    vi.mocked(internalFetch).mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'connector token broker failed: forbidden',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('forwards project access context to the connector token broker', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'member-gw';
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      readConnectorAccessToken('u-alice', 'github', {
        kind: 'project',
        requestingUid: 'u-bob',
        workspaceSlug: 'alice',
        projectSlug: 'octo',
      }),
    ).resolves.toBe('gho_brokered');

    expect(internalFetch).toHaveBeenCalledWith(
      'http://octogee-api.octogee-test.svc.cluster.local:3001/internal/connectors/access-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          gatewayId: 'member-gw',
          uid: 'u-alice',
          connectorId: 'github',
          access: {
            kind: 'project',
            requestingUid: 'u-bob',
            workspaceSlug: 'alice',
            projectSlug: 'octo',
          },
        }),
      }),
      expect.any(Object),
    );
  });

  it('reads directly from Firestore+KMS when it is the connector-token authority (broker host, no broker URL)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-alice/secrets/github'] = {
      provider: 'github',
      tokens: { encryptedAccessToken: 'ENC:gho_direct', encryptedRefreshToken: null },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_direct');
    expect(internalFetch).not.toHaveBeenCalled();
    expect(decryptSecret).toHaveBeenCalledWith('ENC:gho_direct');
  });

  it('authority direct-read returns null when the user has no stored token', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';

    await expect(readConnectorAccessToken('u-nobody', 'github')).resolves.toBeNull();
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('the broker URL takes precedence over the authority flag (a gateway never reads direct)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.GATEWAY_ID = 'default';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-must-not-be-read' },
    };
    vi.mocked(internalFetch).mockResolvedValue(
      new Response(JSON.stringify({ accessToken: 'gho_brokered' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(readConnectorAccessToken('u-alice', 'github')).resolves.toBe('gho_brokered');
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('broker URL + authority but no GATEWAY_ID fails closed — never degrades to a direct read', async () => {
    process.env.CONNECTOR_TOKEN_BROKER_URL = 'http://octogee-api.octogee-test.svc.cluster.local:3001';
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:local-must-not-be-read' },
    };

    await expect(readConnectorAccessToken('u-alice', 'github')).rejects.toThrow(
      'CONNECTOR_TOKEN_BROKER_URL is set but GATEWAY_ID is missing',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });

  it('the authority direct-read enforces the brokerable allowlist (only code-hosting platform-read)', async () => {
    process.env.CONNECTOR_TOKEN_AUTHORITY = '1';
    firestoreData['users/u-dan/secrets/google'] = {
      tokens: { encryptedAccessToken: 'ENC:ya29_must_not_be_read' },
    };

    await expect(readConnectorAccessToken('u-dan', 'google')).rejects.toThrow(
      'connector not brokerable: google',
    );
    expect(decryptSecret).not.toHaveBeenCalled();
  });
});

describe('readConnectorClientCreds — per-user first, platform env fallback', () => {
  it("per-user connectors prefer the user's own encrypted client creds over env", async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    firestoreData['users/u-dan/secrets/google'] = {
      client: {
        encryptedClientId: 'ENC:dan-client.apps.googleusercontent.com',
        encryptedClientSecret: 'ENC:dan-secret',
      },
    };
    await expect(readConnectorClientCreds('u-dan', getConnector('google')!)).resolves.toEqual({
      clientId: 'dan-client.apps.googleusercontent.com',
      clientSecret: 'dan-secret',
      source: 'per-user',
    });
  });

  it('per-user connectors fall back to the platform env client (zero-setup mode)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    firestoreData['users/u-dan/secrets/google'] = { tokens: {} };
    await expect(readConnectorClientCreds('u-dan', getConnector('google')!)).resolves.toEqual({
      clientId: 'env-id',
      clientSecret: 'env-secret',
      source: 'platform',
    });
  });

  it('per-user connectors return null only when user client AND env are both absent', async () => {
    firestoreData['users/u-dan/secrets/google'] = { tokens: {} };
    await expect(readConnectorClientCreds('u-dan', getConnector('google')!)).resolves.toBeNull();
  });

  it('a forSource pin resolves exactly that source (refresh must reuse the minting client)', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    firestoreData['users/u-dan/secrets/google'] = {
      client: {
        encryptedClientId: 'ENC:dan-client',
        encryptedClientSecret: 'ENC:dan-secret',
      },
    };
    await expect(
      readConnectorClientCreds('u-dan', getConnector('google')!, 'platform'),
    ).resolves.toEqual({ clientId: 'env-id', clientSecret: 'env-secret', source: 'platform' });
    await expect(
      readConnectorClientCreds('u-dan', getConnector('google')!, 'per-user'),
    ).resolves.toEqual({ clientId: 'dan-client', clientSecret: 'dan-secret', source: 'per-user' });
  });

  it('platform connectors read env and ignore any per-user doc', async () => {
    const microsoftLike = getConnector('microsoft')!;
    process.env.MICROSOFT_CLIENT_ID = 'ms-env-id';
    process.env.MICROSOFT_CLIENT_SECRET = 'ms-env-secret';
    await expect(readConnectorClientCreds('u-dan', microsoftLike)).resolves.toEqual({
      clientId: 'ms-env-id',
      clientSecret: 'ms-env-secret',
      source: 'platform',
    });
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  it('platform connectors return null when env is unset', async () => {
    await expect(readConnectorClientCreds('u-dan', getConnector('microsoft')!)).resolves.toBeNull();
  });
});

describe('getFreshAccessToken — refresh-aware access', () => {
  function seedGoogleTokens(overrides: Record<string, unknown> = {}) {
    firestoreData['users/u-dan/secrets/google'] = {
      provider: 'google',
      client: {
        encryptedClientId: 'ENC:dan-client',
        encryptedClientSecret: 'ENC:dan-secret',
      },
      tokens: {
        encryptedAccessToken: 'ENC:stale-access',
        encryptedRefreshToken: 'ENC:long-lived-refresh',
        expiresAt: Date.now() + 30 * 60 * 1000,
        tokenType: 'Bearer',
        ...overrides,
      },
    };
  }

  it('returns the stored token while it is still fresh (no provider call)', async () => {
    seedGoogleTokens();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await getFreshAccessToken('u-dan', getConnector('google')!);
    expect(out).toEqual({ ok: true, accessToken: 'stale-access' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes a platform-captured token with the platform client, even when a user client exists', async () => {
    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    seedGoogleTokens({ expiresAt: Date.now() - 1000, clientSource: 'platform' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, init?: RequestInit) => {
        const body = String(init?.body);
        expect(body).toContain('client_id=env-id');
        expect(body).toContain('client_secret=env-secret');
        return new Response(
          JSON.stringify({ access_token: 'fresh-platform', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: true,
      accessToken: 'fresh-platform',
    });
  });

  it('refreshes an expired token with the per-user client and persists the rotation', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        expect(String(url)).toBe('https://oauth2.googleapis.com/token');
        const body = String(init?.body);
        expect(body).toContain('grant_type=refresh_token');
        expect(body).toContain('refresh_token=long-lived-refresh');
        expect(body).toContain('client_id=dan-client');
        expect(body).toContain('client_secret=dan-secret');
        return new Response(
          JSON.stringify({ access_token: 'fresh-access', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const out = await getFreshAccessToken('u-dan', getConnector('google')!);
    expect(out).toEqual({ ok: true, accessToken: 'fresh-access' });

    const write = docWrites.find((w) => w.path === 'users/u-dan/secrets/google');
    expect(write?.merge).toBe(true);
    const tokens = (write?.data as { tokens: Record<string, unknown> }).tokens;
    expect(tokens.encryptedAccessToken).toBe('ENC:fresh-access');
    expect(tokens.encryptedRefreshToken).toBe('ENC:long-lived-refresh');
  });

  it('reports reauth_required when the provider rejects the refresh token', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('a lost refresh race re-reads the doc and returns the winning rotation instead of reauth', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        firestoreData['users/u-dan/secrets/google'].tokens = {
          encryptedAccessToken: 'ENC:winner-access',
          encryptedRefreshToken: 'ENC:winner-refresh',
          expiresAt: Date.now() + 3600_000,
          tokenType: 'Bearer',
        };
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: true,
      accessToken: 'winner-access',
    });
  });

  it('reports reauth_required when an expired token has no refresh token', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000, encryptedRefreshToken: null });
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('reports reauth_required when an expired token has a blank refresh token', async () => {
    seedGoogleTokens({ expiresAt: Date.now() - 1000, encryptedRefreshToken: '   ' });
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'reauth_required',
    });
  });

  it('reports not_connected when there are no stored tokens', async () => {
    await expect(getFreshAccessToken('u-dan', getConnector('google')!)).resolves.toEqual({
      ok: false,
      reason: 'not_connected',
    });
  });

  it('tokens without an expiry (github PATs) pass through untouched', async () => {
    firestoreData['users/u-alice/secrets/github'] = {
      tokens: { encryptedAccessToken: 'ENC:ghp_token', encryptedRefreshToken: null },
    };
    await expect(getFreshAccessToken('u-alice', getConnector('github')!)).resolves.toEqual({
      ok: true,
      accessToken: 'ghp_token',
    });
  });
});
