import { log } from "../config.js";

let _mmAdminToken: string | null = null;

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
    } catch (e: any) {
      log(`⚠ [mattermost] Admin login error: ${e.message}`);
    }
  }

  if (process.env.MM_BOT_TOKEN) {
    log("[mattermost] ⚠ Using bot token — some operations (personal access tokens) will fail");
    _mmAdminToken = process.env.MM_BOT_TOKEN;
    return _mmAdminToken;
  }

  return null;
}

export async function mmApiCall(method: string, endpoint: string, body?: any): Promise<any | null> {
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
    log(`⚠ [mattermost] API ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return resp.json();
}
