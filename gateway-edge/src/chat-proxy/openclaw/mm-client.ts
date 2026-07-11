import type { MmClient, MmPostInput } from "./activity-bridge.js";
import { assertCompatibleDeliveryOptions } from "./activity-attention-policy.js";

export interface MmClientFactoryOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function createMmClientFactory(options: MmClientFactoryOptions): (token: string) => MmClient {
  const factory = createActivityMmClientFactory(options);
  return (token: string) => factory(token);
}

export interface ActivityMattermostPostInput extends MmPostInput {
  silent: boolean;
  pendingPostId: string;
  fileIds?: string[];
  persistentNotification?: boolean;
  forceNotification?: boolean;
}

export interface ActivityMattermostPost {
  id: string;
  channelId: string;
  rootId: string;
  message?: string;
  props: Record<string, unknown>;
  fileIds: string[];
}

export interface ActivityMattermostHistoryPage {
  posts: ActivityMattermostPost[];
  nextBefore?: string;
  reachedEnd: boolean;
}

export interface MattermostUploadSession {
  id: string;
  fileOffset: number;
}

export type MattermostUploadResult =
  | { outcome: "incomplete" }
  | { outcome: "complete"; fileId: string };

export interface MattermostFileInfo {
  id: string;
  size: number;
}

export interface ActivityMattermostClient extends MmClient {
  createActivityPost(input: ActivityMattermostPostInput): Promise<{ id: string }>;
  getPost(postId: string): Promise<ActivityMattermostPost | null>;
  listChannelPosts(
    channelId: string,
    before?: string,
    perPage?: number,
  ): Promise<ActivityMattermostHistoryPage>;
  createUploadSession(
    channelId: string,
    filename: string,
    byteLength: number,
  ): Promise<MattermostUploadSession>;
  getUploadSession(uploadId: string): Promise<MattermostUploadSession | null>;
  uploadData(uploadId: string, bytes: Uint8Array): Promise<MattermostUploadResult>;
  getFileInfo(fileId: string): Promise<MattermostFileInfo | null>;
  getPostFiles(postId: string): Promise<MattermostFileInfo[]>;
  withUserToken(nextToken: string): ActivityMattermostClient;
}

interface MmPostResponse {
  id?: unknown;
  channel_id?: unknown;
  root_id?: unknown;
  props?: unknown;
  file_ids?: unknown;
  message?: unknown;
}

function safeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function postFromResponse(value: MmPostResponse): ActivityMattermostPost | null {
  if (typeof value.id !== "string" || typeof value.channel_id !== "string") return null;
  return {
    id: value.id,
    channelId: value.channel_id,
    rootId: typeof value.root_id === "string" ? value.root_id : "",
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    props:
      value.props && typeof value.props === "object"
        ? (value.props as Record<string, unknown>)
        : {},
    fileIds: Array.isArray(value.file_ids)
      ? value.file_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function uploadSessionFromResponse(value: Record<string, unknown>): MattermostUploadSession | null {
  if (
    typeof value.id !== "string" ||
    !safeNonNegativeInteger(value.file_offset)
  ) return null;
  return { id: value.id, fileOffset: value.file_offset };
}

function fileInfoFromResponse(value: Record<string, unknown>): MattermostFileInfo | null {
  if (
    typeof value.id !== "string" ||
    !safeNonNegativeInteger(value.size)
  ) return null;
  return { id: value.id, size: value.size };
}

export function createActivityMmClientFactory(
  options: MmClientFactoryOptions,
): (token: string) => ActivityMattermostClient {
  const baseUrl = options.baseUrl.replace(/\/{1,32}$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;

  const fetchAs = async (token: string, path: string, init: RequestInit): Promise<Response> => {
    const url = `${baseUrl}/api/v4${path}`;
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (typeof init.body === "string" && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetchImpl(url, { ...init, headers });
  };

  const requireOk = async (response: Response, operation: string): Promise<void> => {
    if (response.ok) return;
    const body = await response.text();
    throw new Error(`MM ${operation} ${response.status}: ${body.slice(0, 200)}`);
  };

  const requireJson = async <T>(response: Response, operation: string): Promise<T> => {
    await requireOk(response, operation);
    return response.json() as Promise<T>;
  };

  const buildClient = (token: string): ActivityMattermostClient => ({
    async createPost(input: MmPostInput): Promise<{ id: string }> {
      const body = {
        channel_id: input.channelId,
        ...(input.rootId ? { root_id: input.rootId } : {}),
        message: input.message,
        ...(input.pendingPostId ? { pending_post_id: input.pendingPostId } : {}),
        ...(input.props ? { props: input.props } : {}),
      };
      const res = await fetchAs(token, "/posts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const json = await requireJson<{ id?: string }>(res, "createPost");
      if (!json.id) {
        throw new Error("MM createPost returned no id");
      }
      return { id: json.id };
    },

    async createActivityPost(input): Promise<{ id: string }> {
      assertCompatibleDeliveryOptions(input);
      const query = input.silent ? "?silent=true" : "";
      const body = {
        channel_id: input.channelId,
        ...(input.rootId ? { root_id: input.rootId } : {}),
        message: input.message,
        pending_post_id: input.pendingPostId,
        ...(input.fileIds ? { file_ids: input.fileIds } : {}),
        ...(input.props ? { props: input.props } : {}),
        ...(input.persistentNotification
          ? {
              metadata: {
                priority: {
                  priority: "urgent",
                  persistent_notifications: true,
                },
              },
            }
          : {}),
      };
      const response = await fetchAs(token, `/posts${query}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const json = await requireJson<{ id?: unknown }>(response, "createActivityPost");
      if (typeof json.id !== "string" || !json.id) {
        throw new Error("MM createActivityPost returned no id");
      }
      return { id: json.id };
    },

    async editPost(postId: string, input: Pick<MmPostInput, "message" | "props">): Promise<void> {
      const body: Record<string, unknown> = { id: postId, message: input.message };
      if (input.props) {
        body.props = input.props;
      }
      const res = await fetchAs(token, `/posts/${postId}/patch`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      await requireOk(res, "editPost");
    },

    async deletePost(postId: string): Promise<void> {
      const res = await fetchAs(token, `/posts/${postId}`, { method: "DELETE" });
      await requireOk(res, "deletePost");
    },

    async getPost(postId): Promise<ActivityMattermostPost | null> {
      const response = await fetchAs(token, `/posts/${encodeURIComponent(postId)}`, {
        method: "GET",
      });
      if (response.status === 404) return null;
      const json = await requireJson<MmPostResponse>(response, "getPost");
      const post = postFromResponse(json);
      if (!post) throw new Error("MM getPost returned a malformed post");
      return post;
    },

    async listChannelPosts(
      channelId,
      before,
      perPage = 100,
    ): Promise<ActivityMattermostHistoryPage> {
      const params = new URLSearchParams();
      if (before) params.set("before", before);
      params.set("per_page", String(perPage));
      const response = await fetchAs(
        token,
        `/channels/${encodeURIComponent(channelId)}/posts?${params.toString()}`,
        { method: "GET" },
      );
      const json = await requireJson<{
        order?: unknown;
        posts?: unknown;
      }>(response, "listChannelPosts");
      if (!Array.isArray(json.order) || !json.posts || typeof json.posts !== "object") {
        throw new Error("MM listChannelPosts returned malformed history");
      }
      const postsById = json.posts as Record<string, MmPostResponse>;
      const posts = json.order.map((id) => {
        if (typeof id !== "string") throw new Error("MM history contained a non-string id");
        const post = postFromResponse(postsById[id] ?? {});
        if (!post) throw new Error(`MM history omitted post ${id}`);
        return post;
      });
      return {
        posts,
        ...(posts.length > 0 ? { nextBefore: posts.at(-1)!.id } : {}),
        reachedEnd: posts.length < perPage,
      };
    },

    async createUploadSession(channelId, filename, byteLength): Promise<MattermostUploadSession> {
      const response = await fetchAs(token, "/uploads", {
        method: "POST",
        body: JSON.stringify({
          channel_id: channelId,
          filename,
          file_size: byteLength,
        }),
      });
      const json = await requireJson<Record<string, unknown>>(response, "createUploadSession");
      const session = uploadSessionFromResponse(json);
      if (!session) throw new Error("MM createUploadSession returned malformed session");
      return session;
    },

    async getUploadSession(uploadId): Promise<MattermostUploadSession | null> {
      const response = await fetchAs(token, `/uploads/${encodeURIComponent(uploadId)}`, {
        method: "GET",
      });
      if (response.status === 404) return null;
      const json = await requireJson<Record<string, unknown>>(response, "getUploadSession");
      const session = uploadSessionFromResponse(json);
      if (!session) throw new Error("MM getUploadSession returned malformed session");
      return session;
    },

    async uploadData(uploadId, bytes): Promise<MattermostUploadResult> {
      const response = await fetchAs(token, `/uploads/${encodeURIComponent(uploadId)}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes.byteLength),
        },
        body: bytes as BodyInit,
      });
      if (response.status === 204) return { outcome: "incomplete" };
      const json = await requireJson<Record<string, unknown>>(response, "uploadData");
      const file = fileInfoFromResponse(json);
      if (!file) throw new Error("MM uploadData returned malformed file info");
      return { outcome: "complete", fileId: file.id };
    },

    async getFileInfo(fileId): Promise<MattermostFileInfo | null> {
      const response = await fetchAs(token, `/files/${encodeURIComponent(fileId)}/info`, {
        method: "GET",
      });
      if (response.status === 404) return null;
      const json = await requireJson<Record<string, unknown>>(response, "getFileInfo");
      const file = fileInfoFromResponse(json);
      if (!file) throw new Error("MM getFileInfo returned malformed file info");
      return file;
    },

    async getPostFiles(postId): Promise<MattermostFileInfo[]> {
      const response = await fetchAs(
        token,
        `/posts/${encodeURIComponent(postId)}/files/info`,
        { method: "GET" },
      );
      const json = await requireJson<Array<Record<string, unknown>>>(response, "getPostFiles");
      return json.map((value) => {
        const file = fileInfoFromResponse(value);
        if (!file) throw new Error("MM getPostFiles returned malformed file info");
        return file;
      });
    },

    withUserToken(nextToken: string): ActivityMattermostClient {
      return buildClient(nextToken);
    },
  });

  return buildClient;
}
