import { randomUUID } from "node:crypto";
import WebSocket from "ws";

export const SILENT_POST_CAPABILITY_SENTINEL = "octogee:mattermost-silent-post:v1";

export interface MattermostSilentPostProbeConfig {
  baseUrl: string;
  channelId: string;
  observerUserId: string;
  observerUsername: string;
  botToken: string;
  humanToken: string;
  observerToken: string;
  sourceCapabilitySentinel: string;
}

export interface MattermostUnread {
  msgCount: number;
  mentionCount: number;
}

export interface SilentPostCreateRequest {
  actor: "bot" | "human";
  message: string;
  silent: boolean;
  persistentNotification: boolean;
}

export interface SilentPostCreateResult {
  status: number;
  id?: string;
  props?: Record<string, unknown>;
}

export interface SilentPostProbeDeps {
  sourceCapabilitySentinel: string;
  readUnread(): Promise<MattermostUnread>;
  createPost(request: SilentPostCreateRequest): Promise<SilentPostCreateResult>;
  waitForWebsocketPost(postId: string): Promise<void>;
}

export interface SilentPostCapabilityReport {
  persisted: boolean;
  websocketDelivered: boolean;
  unreadUnchanged: boolean;
  mentionUnchanged: boolean;
  ordinaryFinalNotifies: boolean;
  humanSilentRejected: boolean;
  persistentSilentRejected: boolean;
}

function sameUnread(left: MattermostUnread, right: MattermostUnread): boolean {
  return left.msgCount === right.msgCount;
}

function sameMentions(left: MattermostUnread, right: MattermostUnread): boolean {
  return left.mentionCount === right.mentionCount;
}

export async function verifySilentPostCapability(
  deps: SilentPostProbeDeps,
): Promise<SilentPostCapabilityReport> {
  if (deps.sourceCapabilitySentinel !== SILENT_POST_CAPABILITY_SENTINEL) {
    throw new Error("Mattermost silent capability artifact is not approved");
  }
  const nonce = randomUUID();
  const before = await deps.readUnread();
  const silent = await deps.createPost({
    actor: "bot",
    message: `silent capability ${nonce}`,
    silent: true,
    persistentNotification: false,
  });
  if (silent.status !== 201 || !silent.id || silent.props?.silent_notification !== true) {
    throw new Error(`silent bot post failed capability contract: HTTP ${silent.status}`);
  }
  await deps.waitForWebsocketPost(silent.id);
  const afterSilent = await deps.readUnread();
  const normal = await deps.createPost({
    actor: "bot",
    message: `normal final ${nonce}`,
    silent: false,
    persistentNotification: false,
  });
  if (normal.status !== 201 || !normal.id) {
    throw new Error(`normal final post failed capability contract: HTTP ${normal.status}`);
  }
  await deps.waitForWebsocketPost(normal.id);
  const afterNormal = await deps.readUnread();
  const human = await deps.createPost({
    actor: "human",
    message: `human silent denial ${nonce}`,
    silent: true,
    persistentNotification: false,
  });
  const persistent = await deps.createPost({
    actor: "bot",
    message: `persistent silent denial ${nonce}`,
    silent: true,
    persistentNotification: true,
  });
  return {
    persisted: true,
    websocketDelivered: true,
    unreadUnchanged: sameUnread(before, afterSilent),
    mentionUnchanged: sameMentions(before, afterSilent),
    ordinaryFinalNotifies:
      afterNormal.msgCount > afterSilent.msgCount &&
      afterNormal.mentionCount > afterSilent.mentionCount,
    humanSilentRejected: human.status === 403,
    persistentSilentRejected: persistent.status >= 400 && persistent.status < 600,
  };
}

function valueArg(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function parseSilentPostProbeArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): MattermostSilentPostProbeConfig | null {
  const config = {
    baseUrl: nonBlank(valueArg(argv, "base-url") ?? env.MM_URL),
    channelId: nonBlank(valueArg(argv, "channel-id") ?? env.MM_SILENT_PROBE_CHANNEL_ID),
    observerUserId: nonBlank(
      valueArg(argv, "observer-user-id") ?? env.MM_SILENT_PROBE_OBSERVER_USER_ID,
    ),
    observerUsername: nonBlank(
      valueArg(argv, "observer-username") ?? env.MM_SILENT_PROBE_OBSERVER_USERNAME,
    ),
    botToken: nonBlank(env.MM_BOT_TOKEN),
    humanToken: nonBlank(env.MM_HUMAN_TOKEN),
    observerToken: nonBlank(env.MM_OBSERVER_TOKEN),
    sourceCapabilitySentinel: nonBlank(env.MATTERMOST_SILENT_CAPABILITY_SENTINEL),
  };
  if (Object.values(config).some((value) => value === undefined)) return null;
  return config as MattermostSilentPostProbeConfig;
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/{1,32}$/, "");
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

interface ObserverSocket {
  waitForPost(postId: string): Promise<void>;
  close(): void;
}

function waitForObservedPost(
  received: ReadonlySet<string>,
  waiters: Map<string, () => void>,
  postId: string,
): Promise<void> {
  if (received.has(postId)) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      waiters.delete(postId);
      reject(new Error(`Mattermost websocket did not deliver post ${postId}`));
    }, 10_000);
    waiters.set(postId, () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function createObserverSocket(config: MattermostSilentPostProbeConfig): Promise<ObserverSocket> {
  const baseUrl = trimBaseUrl(config.baseUrl);
  const websocketUrl = `${baseUrl.replace(/^http/, "ws")}/api/v4/websocket`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    const received = new Set<string>();
    const waiters = new Map<string, () => void>();
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Mattermost observer websocket authentication timed out"));
    }, 10_000);
    socket.on("open", () => {
      socket.send(JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token: config.observerToken },
      }));
    });
    socket.on("message", (data) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (frame.seq_reply === 1 && frame.status === "OK") {
        clearTimeout(timeout);
        resolve({
          waitForPost: (postId) => waitForObservedPost(received, waiters, postId),
          close: () => socket.close(),
        });
        return;
      }
      const dataRecord = frame.data;
      if (frame.event !== "posted" || !dataRecord || typeof dataRecord !== "object") return;
      const rawPost = (dataRecord as Record<string, unknown>).post;
      if (typeof rawPost !== "string") return;
      try {
        const post = JSON.parse(rawPost) as { id?: unknown };
        if (typeof post.id !== "string") return;
        received.add(post.id);
        waiters.get(post.id)?.();
        waiters.delete(post.id);
      } catch {
        return;
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

export async function runMattermostSilentPostProbe(
  config: MattermostSilentPostProbeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SilentPostCapabilityReport> {
  const baseUrl = trimBaseUrl(config.baseUrl);
  const observer = await createObserverSocket(config);
  const tokenFor = (actor: "bot" | "human") =>
    actor === "bot" ? config.botToken : config.humanToken;
  try {
    return await verifySilentPostCapability({
      sourceCapabilitySentinel: config.sourceCapabilitySentinel,
      async readUnread() {
        const response = await fetchImpl(
          `${baseUrl}/api/v4/users/${encodeURIComponent(config.observerUserId)}/channels/${encodeURIComponent(config.channelId)}/unread`,
          { headers: { Authorization: `Bearer ${config.observerToken}` } },
        );
        if (!response.ok) throw new Error(`Mattermost unread probe failed: HTTP ${response.status}`);
        const body = await responseJson(response);
        if (typeof body.msg_count !== "number" || typeof body.mention_count !== "number") {
          throw new Error("Mattermost unread probe returned malformed counts");
        }
        return { msgCount: body.msg_count, mentionCount: body.mention_count };
      },
      async createPost(request) {
        const query = request.silent ? "?silent=true" : "";
        const response = await fetchImpl(`${baseUrl}/api/v4/posts${query}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenFor(request.actor)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel_id: config.channelId,
            message: `@${config.observerUsername} ${request.message}`,
            ...(request.persistentNotification
              ? {
                  metadata: {
                    priority: {
                      priority: "urgent",
                      persistent_notifications: true,
                    },
                  },
                }
              : {}),
          }),
        });
        const body = await responseJson(response);
        return {
          status: response.status,
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          ...(body.props && typeof body.props === "object"
            ? { props: body.props as Record<string, unknown> }
            : {}),
        };
      },
      waitForWebsocketPost: (postId) => observer.waitForPost(postId),
    });
  } finally {
    observer.close();
  }
}
