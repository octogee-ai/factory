import { createHash } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentActivityCanonicalKey,
  type AgentActivityEnvelopeV1,
} from "@octogee/shared/types/agent-conversation";
import {
  chatProxyHandleRequest,
  installActivityIntakeHandler,
} from "../proxy.js";
import { createActivityIntakeHttpHandler } from "../openclaw/activity-intake.js";

function envelopeWithAttachment(bytes?: Uint8Array): AgentActivityEnvelopeV1 {
  const ref = {
    conversationId: "main-1",
    turnId: "turn-1",
    runId: "run-1",
    agentId: "agent-1",
    sessionKey: "agent:agent-1:mattermost:channel:main-1",
    origin: "human" as const,
    mainChannelId: "main-1",
    mainRootPostId: "turn-1",
    inputPostId: "turn-1",
    itemId: "tool-1",
    ordinal: 1,
    semanticVersion: 1,
  };
  return {
    schemaVersion: 1,
    eventKey: createHash("sha256").update(agentActivityCanonicalKey(ref)).digest("hex"),
    emittedAt: "2026-07-11T15:00:00.000Z",
    ref,
    redaction: { policy: "octogee-v1", appliedAt: "producer" },
    type: "item.completed",
    item: {
      kind: "tool",
      status: "completed",
      summary: "Ran inspection",
      ...(bytes
        ? {
            attachment: {
              filename: "tool.txt",
              mediaType: "text/plain",
              byteLength: bytes.byteLength,
              sha256: createHash("sha256").update(bytes).digest("hex"),
              multipartField: "detail" as const,
            },
          }
        : {}),
    },
  };
}

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    void chatProxyHandleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

afterEach(() => installActivityIntakeHandler(null));

describe("POST /internal/openclaw/activity/v1/events", () => {
  it("owns the bare loopback JSON route and returns the normalized 201 response", async () => {
    const append = vi.fn(async () => ({ outcome: "persisted" as const, postIds: ["post-1"] }));
    const envelope = envelopeWithAttachment();
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
        })),
      },
      sinkFor: () => ({ append }),
    }));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({ outcome: "persisted", postIds: ["post-1"] });
    });
  });

  it("parses the one-envelope/one-detail multipart contract and enforces its file limit", async () => {
    const append = vi.fn(async () => ({ outcome: "persisted" as const, postIds: ["post-1"] }));
    const bytes = Buffer.from("eight-bytes");
    const envelope = envelopeWithAttachment(bytes);
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
        })),
      },
      sinkFor: () => ({ append }),
    }, { maxAttachmentBytes: 4 }));

    await withServer(async (baseUrl) => {
      const form = new FormData();
      form.set("envelope", JSON.stringify(envelope));
      form.set("detail", new Blob([bytes], { type: "text/plain" }), "tool.txt");
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "attachment_too_large", retryable: false });
      expect(append).not.toHaveBeenCalled();
    });
  });

  it("does not expose the route through a fleet-prefixed public path", async () => {
    installActivityIntakeHandler(vi.fn());
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/g/gw-1/internal/openclaw/activity/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(404);
    });
  });
});
