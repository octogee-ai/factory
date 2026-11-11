import { WebSocket } from "ws";
import { LoadHttpError, MAX_LOAD_RUN_MS, TEST_API_ORIGIN, TEST_APP_ORIGIN, TEST_FIREBASE_PROJECT, type LoadClient, type LoadTarget } from "./gateway-load-test.js";

export function testToken(target: LoadTarget, env: NodeJS.ProcessEnv): { token: string; uid: string } {
  const token = env[target.tokenEnv];
  if (!token) throw new Error(`Missing ${target.tokenEnv}`);
  let claims: { aud?: unknown; iss?: unknown; exp?: unknown; sub?: unknown };
  try { claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { throw new Error(`Invalid TEST token for ${target.name}`); }
  if (claims.aud !== TEST_FIREBASE_PROJECT || claims.iss !== `https://securetoken.google.com/${TEST_FIREBASE_PROJECT}`
    || typeof claims.sub !== "string" || !claims.sub
    || typeof claims.exp !== "number" || claims.exp * 1_000 < Date.now() + MAX_LOAD_RUN_MS + 5 * 60_000) {
    throw new Error(`A fresh ${TEST_FIREBASE_PROJECT} Firebase ID token with at least 35 minutes remaining is required for ${target.name}`);
  }
  return { token, uid: claims.sub };
}

export function testTokens(targets: LoadTarget[], env: NodeJS.ProcessEnv): Map<string, string> {
  const identities = new Set<string>();
  return new Map(targets.map((target) => {
    const { token, uid } = testToken(target, env);
    if (identities.has(uid)) throw new Error("Targets must use distinct Firebase identities");
    identities.add(uid);
    return [target.name, token];
  }));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function defaultAgentMessages(history: unknown, channelId: string, userDefaultAgentId: string) {
  const data = record(history), posts = record(data.posts);
  if (!Array.isArray(data.order) || !data.posts || typeof data.posts !== "object" || Array.isArray(data.posts)) throw new Error("Invalid Mattermost history");
  const messages: { role: string; content: string }[] = [];
  for (const id of data.order) {
    const post = record(posts[String(id)]), meta = record(record(post.props).octogee);
    if (post.channel_id === channelId && post.user_id === userDefaultAgentId && post.delete_at === 0 && post.type === ""
      && !meta.kind && !meta.itemId && typeof post.message === "string") messages.push({ role: "assistant", content: post.message });
  }
  return { messages };
}

function authenticate(ws: WebSocket, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer); ws.off("open", open); ws.off("message", message); ws.off("close", closed); ws.off("error", closed);
      if (error) reject(error); else resolve();
    };
    const closed = () => finish(new Error("Mattermost authentication socket closed"));
    const open = () => {
      try { ws.send(JSON.stringify({ seq: 1, action: "authentication_challenge", data: { token } })); }
      catch { closed(); }
    };
    const message = (raw: Buffer) => {
      let frame: Record<string, unknown>;
      try { frame = record(JSON.parse(raw.toString())); }
      catch { finish(new Error("Invalid Mattermost authentication frame")); return; }
      if (frame.seq_reply === 1) finish(frame.status === "OK" ? undefined : new Error("Mattermost authentication rejected"));
    };
    const timer = setTimeout(() => finish(new Error("Mattermost authentication timeout")), 30_000);
    ws.once("open", open); ws.on("message", message); ws.once("close", closed); ws.once("error", closed);
  });
}

export async function connectLoadClient(input: {
  target: LoadTarget;
  gatewayId: string;
  token: string;
  signal: AbortSignal;
}): Promise<LoadClient> {
  const { target, gatewayId, token, signal } = input;
  const request = async (path: string, bearer: string, init: RequestInit = {}) => {
    const response = await fetch(`${TEST_API_ORIGIN}${path}`, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${bearer}` },
      redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new LoadHttpError(response.status);
    return record(await response.json());
  };
  const route = await request("/api/mattermost/token", token);
  if (route.gatewayId !== gatewayId || typeof route.defaultAgentMmUserId !== "string" || !/^[a-z0-9]{26}$/.test(route.defaultAgentMmUserId)) {
    throw new Error("Unexpected TEST gateway route or agent");
  }
  const credentials = await request("/api/auth/mattermost", token, { method: "POST" });
  if (credentials.mmUrl !== TEST_API_ORIGIN || typeof credentials.mmToken !== "string" || !credentials.mmToken
    || typeof credentials.mmUserId !== "string" || !/^[a-z0-9]{26}$/.test(credentials.mmUserId) || credentials.mmUserId !== route.mmUserId) {
    throw new Error("Unexpected TEST Mattermost credentials");
  }
  const mmToken = credentials.mmToken, userDefaultAgentId = route.defaultAgentMmUserId;
  signal.throwIfAborted();
  const ws = new WebSocket(`${TEST_API_ORIGIN.replace(/^https:/, "wss:")}/g/${gatewayId}/api/v4/websocket`, {
    headers: { Origin: TEST_APP_ORIGIN }, maxPayload: 4 * 1024 * 1024,
  });
  let socketFailed = false;
  ws.on("error", () => { socketFailed = true; });
  const close = () => { signal.removeEventListener("abort", close); ws.terminate(); };
  signal.addEventListener("abort", close, { once: true });
  const check = () => {
    signal.throwIfAborted();
    if (socketFailed || ws.readyState !== WebSocket.OPEN) throw new Error("Mattermost socket is unavailable");
  };
  try {
    await authenticate(ws, mmToken);
    return {
      read: async () => {
        check();
        const history = await request(`/api/v4/channels/${target.channelId}/posts?page=0&per_page=100`, mmToken);
        check();
        return defaultAgentMessages(history, target.channelId, userDefaultAgentId);
      },
      send: async (message, idempotencyKey) => {
        check();
        const post = await request("/api/v4/posts", mmToken, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel_id: target.channelId, message, pending_post_id: idempotencyKey }) });
        if (typeof post.id !== "string" || !/^[a-z0-9]{26}$/.test(post.id) || post.channel_id !== target.channelId || post.user_id !== credentials.mmUserId) {
          throw new Error("Unexpected Mattermost send acknowledgement");
        }
      },
      close,
    };
  } catch (error) { close(); throw error; }
}
