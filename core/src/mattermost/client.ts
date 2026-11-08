import { log } from "../config.js";

const IDEMPOTENT_MM_ERROR_IDS = new Set<string>([
  "store.sql_channel.save_channel.exists.app_error",
]);

let _mmAdminToken: string | null = null;

export function assertMattermostConfigured(): void {
  const hasUrl = !!process.env.MM_URL;
  const hasToken = !!process.env.MM_ADMIN_TOKEN;
  if (!hasUrl || !hasToken) {
    throw new Error(
      "[mattermost] not configured for provisioning — need MM_URL and MM_ADMIN_TOKEN: " +
        `MM_URL=${hasUrl ? "set" : "MISSING"} adminToken=${hasToken ? "set" : "MISSING"}`,
    );
  }
}

export async function getMmAdminToken(): Promise<string | null> {
  if (_mmAdminToken) return _mmAdminToken;

  if (process.env.MM_ADMIN_TOKEN) {
    _mmAdminToken = process.env.MM_ADMIN_TOKEN;
    return _mmAdminToken;
  }

  const MM_URL = process.env.MM_URL;
  const user = process.env.MM_ADMIN_USER;
  const pass = process.env.MM_ADMIN_PASS;
  if (MM_URL && user && pass) {
    try {
      const resp = await fetch(`${MM_URL}/api/v4/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ login_id: user, password: pass }),
      });
      if (resp.ok) {
        const token = resp.headers.get("token");
        if (token) {
          _mmAdminToken = token;
          log("[mattermost] Admin session token acquired via login");
          return _mmAdminToken;
        }
      }
      const text = await resp.text().catch(() => "");
      log(`⚠ [mattermost] Admin login failed (${resp.status}): ${text.slice(0, 200)}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`⚠ [mattermost] Admin login error: ${msg}`);
    }
  }

  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- broad MM API shape; callers do their own narrowing
export async function mmApiCall(method: string, endpoint: string, body?: unknown): Promise<any | null> {
  const MM_URL = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!MM_URL || !token) return null;

  const resp = await fetch(`${MM_URL}/api/v4${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    if (isIdempotentMmError(text)) {
      log(`[mattermost] API ${resp.status} (idempotent): ${text.slice(0, 200)}`);
    } else {
      log(`⚠ [mattermost] API ${resp.status}: ${text.slice(0, 200)}`);
    }
    return null;
  }
  return resp.json();
}

export async function mmApiCallStrict(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<unknown | null> {
  const url = process.env.MM_URL;
  const token = await getMmAdminToken();
  if (!url || !token) throw new Error("Mattermost strict API is not configured");
  const response = await fetch(`${url}/api/v4${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(
      `MM API ${response.status}: ${detail.slice(0, 200)}`,
    ) as Error & { status: number };
    error.status = response.status;
    throw error;
  }
  if (response.status === 204) return null;
  return await response.json();
}

export function isIdempotentMmError(body: string): boolean {
  for (const id of IDEMPOTENT_MM_ERROR_IDS) {
    if (body.includes(`"id":"${id}"`)) return true;
  }
  return false;
}
