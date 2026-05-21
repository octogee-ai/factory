import type { MmClient, MmPostInput } from "./activity-bridge.js";

export interface MmClientFactoryOptions {
  baseUrl: string;
}

export function createMmClientFactory(options: MmClientFactoryOptions): (token: string) => MmClient {
  const baseUrl = options.baseUrl.replace(/\/{1,32}$/, "");

  const fetchAs = async (token: string, path: string, init: RequestInit): Promise<Response> => {
    const url = `${baseUrl}/api/v4${path}`;
    const headers = new Headers(init.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return fetch(url, { ...init, headers });
  };

  const buildClient = (token: string): MmClient => ({
    async createPost(input: MmPostInput): Promise<{ id: string }> {
      const body = {
        channel_id: input.channelId,
        ...(input.rootId ? { root_id: input.rootId } : {}),
        message: input.message,
        ...(input.props ? { props: input.props } : {}),
      };
      const res = await fetchAs(token, "/posts", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MM createPost ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { id?: string };
      if (!json.id) {
        throw new Error("MM createPost returned no id");
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
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MM editPost ${res.status}: ${text.slice(0, 200)}`);
      }
    },

    async deletePost(postId: string): Promise<void> {
      const res = await fetchAs(token, `/posts/${postId}`, { method: "DELETE" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`MM deletePost ${res.status}: ${text.slice(0, 200)}`);
      }
    },

    withUserToken(nextToken: string): MmClient {
      return buildClient(nextToken);
    },
  });

  return buildClient;
}
