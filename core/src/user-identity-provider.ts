import { createHash } from "node:crypto";
import type { UserRecordsRepository } from "./platform-state/users.js";

export interface VerifiedUser {
  readonly uid: string;
  readonly authTime: number | null;
}

export interface UserDocument {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any;
}

const CREDENTIAL_REJECTED = "UserCredentialRejected";

export class UserCredentialRejected extends Error {
  override readonly name = CREDENTIAL_REJECTED;
}

export function isUserCredentialRejected(error: unknown): error is UserCredentialRejected {
  return error instanceof Error && error.name === CREDENTIAL_REJECTED;
}

export interface UserIdentityProvider {
  verifyBearer(token: string): Promise<VerifiedUser>;
  loadUser(uid: string): Promise<UserDocument | null>;
}

const MATTERMOST_TOKEN = /^[a-z0-9]{26}$/;
const SESSION_MEMORY_MS = 60_000;
const SESSION_MEMORY_ENTRIES = 5_000;
const MATTERMOST_TIMEOUT_MS = 5_000;

interface RememberedSession {
  readonly uid: string;
  readonly expiresAt: number;
}

function mattermostBaseUrl(configured: string): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`the Mattermost URL is not a URL: ${JSON.stringify(configured)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`the Mattermost URL must be http or https: ${JSON.stringify(configured)}`);
  }
  let end = url.href.length;
  while (end > 0 && url.href[end - 1] === "/") end -= 1;
  return url.href.slice(0, end);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mattermostAccountId(fetchImpl: typeof fetch, baseUrl: string, token: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/v4/users/me`, {
      headers: { authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(MATTERMOST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`Mattermost did not answer the session check within ${MATTERMOST_TIMEOUT_MS} ms`, { cause: error });
    }
    throw new Error(`the Mattermost session check failed: ${failureMessage(error)}`, { cause: error });
  }
  if (response.status === 401) throw new UserCredentialRejected("Mattermost rejected the session");
  if (response.status !== 200) throw new Error(`Mattermost answered the session check with HTTP ${response.status}`);
  const account = (await response.json()) as { id?: unknown; is_bot?: unknown; delete_at?: unknown } | null;
  if (typeof account?.id !== "string" || account.id === "" || typeof account.delete_at !== "number") {
    throw new Error("Mattermost answered the session check without an account id and deactivation time");
  }
  if (account.is_bot === true) throw new UserCredentialRejected("a Mattermost bot account cannot act as a user");
  if (account.delete_at !== 0) throw new UserCredentialRejected("the Mattermost account is deactivated");
  return account.id;
}

export function mattermostBearerVerifier(options: {
  readonly mattermostUrl: string;
  readonly users: Pick<UserRecordsRepository, "findByMattermostUserId">;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): UserIdentityProvider["verifyBearer"] {
  const baseUrl = mattermostBaseUrl(options.mattermostUrl);
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sessions = new Map<string, RememberedSession>();

  const remember = (key: string, uid: string): void => {
    sessions.set(key, { uid, expiresAt: now() + SESSION_MEMORY_MS });
    for (const oldest of sessions.keys()) {
      if (sessions.size <= SESSION_MEMORY_ENTRIES) break;
      sessions.delete(oldest);
    }
  };

  return async (token) => {
    if (!MATTERMOST_TOKEN.test(token)) throw new UserCredentialRejected("the bearer is not a Mattermost token");
    const key = createHash("sha256").update(token).digest("hex");
    const remembered = sessions.get(key);
    sessions.delete(key);
    if (remembered !== undefined && remembered.expiresAt > now()) {
      sessions.set(key, remembered);
      return { uid: remembered.uid, authTime: null };
    }
    const mattermostUserId = await mattermostAccountId(fetchImpl, baseUrl, token);
    const user = await options.users.findByMattermostUserId(mattermostUserId);
    if (user === null) throw new UserCredentialRejected("no platform user has this Mattermost account");
    remember(key, user.uid);
    return { uid: user.uid, authTime: null };
  };
}
