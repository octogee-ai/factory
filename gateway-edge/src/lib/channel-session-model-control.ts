import { isValidModelRef } from "@octogee/shared/types/agent-models";
import { containsAsciiControlCharacter } from "./text-validation.js";

const INTERNAL_HOST = /^mattermost\.[a-z0-9-]+\.svc\.cluster\.local$/;
const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface MattermostModelPost {
  id: string;
  root_id: string;
  channel_id: string;
  user_id: string;
  create_at: number;
  message: string;
}

export interface NativeModelResult {
  outcome: "applied" | "rejected" | "unknown";
  currentModel?: string;
  providers?: string[];
  models?: string[];
}

export class ChannelSessionMattermostError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ChannelSessionMattermostError";
  }
}

export function pickCorrelatedAgentReply(
  posts: readonly MattermostModelPost[],
  expected: { rootPostId: string; channelId: string; agentUserId: string; commandCreatedAt: number },
): MattermostModelPost | null {
  return posts
    .filter((post) =>
      post.id !== expected.rootPostId &&
      post.root_id === expected.rootPostId &&
      post.channel_id === expected.channelId &&
      post.user_id === expected.agentUserId &&
      post.create_at >= expected.commandCreatedAt)
    .sort((a, b) => a.create_at - b.create_at)[0] ?? null;
}

export function parseNativeModelResult(operation: string, message: string): NativeModelResult {
  const lines = message.split("\n").map((line) => line.trim());
  const providers = lines.flatMap((line) => {
    const match = /^- ([a-z0-9][a-z0-9._-]{0,127}) \(\d+\)$/i.exec(line);
    return match && PROVIDER.test(match[1]) ? [match[1]] : [];
  });
  const models = lines.flatMap((line) => {
    const candidate = line.startsWith("- ") ? line.slice(2) : "";
    return isValidModelRef(candidate) ? [candidate] : [];
  });
  const currentMatch = /(?:^|\n)(?:🧠\s*)?Model(?::| set to)\s+([^\s·)]+)(?:\s|\)|\.|$)/i.exec(message);
  const resetMatch = /^Model reset to default \(([^)]+)\)/i.exec(message.trim());
  const currentCandidate = currentMatch?.[1] ?? resetMatch?.[1];
  const currentModel = currentCandidate && isValidModelRef(currentCandidate) ? currentCandidate : undefined;
  const rejected = /\b(?:not allowed|unknown provider|unavailable|missing auth|authentication|error)\b/i.test(message);
  const applied = operation === "setSessionModel" || operation === "resetSessionModel"
    ? /^Model (?:set to|reset to default)/i.test(message.trim())
    : false;
  return {
    outcome: rejected ? "rejected" : applied ? "applied" : "unknown",
    ...(currentModel ? { currentModel } : {}),
    ...(providers.length ? { providers: [...new Set(providers)] } : {}),
    ...(models.length ? { models: [...new Set(models)] } : {}),
  };
}

function validatedBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid Mattermost internal base URL"); }
  if (url.protocol !== "http:" || !INTERNAL_HOST.test(url.hostname) || url.port !== "8065" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("invalid Mattermost internal base URL");
  }
  return `${url.protocol}//${url.host}`;
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ChannelSessionMattermostError("Mattermost response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function createChannelSessionMattermostClient(input: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}) {
  const baseUrl = validatedBaseUrl(input.baseUrl);
  if (input.token.length < 16 || input.token.length > 4096 || containsAsciiControlCharacter(input.token) || input.token.includes(" ")) throw new Error("invalid Mattermost token");
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 10_000;
  const maxResponseBytes = input.maxResponseBytes ?? 64 * 1024;
  const requestJson = async (method: "GET" | "POST", segments: readonly string[], body?: unknown): Promise<unknown> => {
    if (!segments.length || segments.some((segment) => !segment || segment.length > 256 || containsAsciiControlCharacter(segment))) throw new Error("invalid Mattermost path");
    const url = `${baseUrl}/api/v4/${segments.map(encodeURIComponent).join("/")}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${input.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw error;
      throw new ChannelSessionMattermostError("Mattermost transport failed");
    }
    let text: string;
    try {
      text = await boundedText(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof ChannelSessionMattermostError) throw error;
      throw new ChannelSessionMattermostError("Mattermost response was invalid", response.status);
    }
    if (!response.ok) throw new ChannelSessionMattermostError(`Mattermost HTTP ${response.status}`, response.status);
    try { return JSON.parse(text) as unknown; } catch { throw new ChannelSessionMattermostError("Mattermost returned malformed JSON", response.status); }
  };
  return {
    getJson: (segments: readonly string[]) => requestJson("GET", segments),
    postJson: (segments: readonly string[], body: unknown) => requestJson("POST", segments, body),
    async getCurrentUserId(): Promise<string> {
      const value = await requestJson("GET", ["users", "me"]);
      const id = (value as { id?: unknown } | null)?.id;
      if (typeof id !== "string") throw new ChannelSessionMattermostError("Mattermost current user response was invalid");
      return id;
    },
  };
}
