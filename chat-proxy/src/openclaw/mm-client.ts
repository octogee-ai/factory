/**
 * mm-client.ts — concrete MmClient implementation used by the activity bridge.
 *
 * The bridge's MmClient interface (activity-bridge.ts) exposes createPost /
 * editPost / deletePost / withUserToken. This module implements them against
 * the Mattermost REST API. All calls use bearer-token auth — the agent's
 * coach PAT for activity posts, the admin PAT for bridge-owned operations
 * (approval-post edits, heartbeat-root deletes).
 */

import type { MmClient, MmPostInput } from "./activity-bridge.js";

export interface MmClientFactoryOptions {
  /** MM API base, e.g. `https://mattermost.octogee.com`. */
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
      // PUT /posts/{post_id}/patch supports partial updates including props.
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
