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
import type { ActivityAttachmentSource } from "../openclaw/activity-sink.js";

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

async function withServer(
  run: (baseUrl: string, responseEnded: () => boolean) => Promise<void>,
): Promise<void> {
  let responseEnded = false;
  const server = http.createServer((req, res) => {
    const end = res.end.bind(res);
    res.end = ((...args: Parameters<typeof res.end>) => {
      responseEnded = true;
      return end(...args);
    }) as typeof res.end;
    void chatProxyHandleRequest(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server port");
  try {
    await run(`http://127.0.0.1:${address.port}`, () => responseEnded);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function sendIncompleteBody(
  baseUrl: string,
  contentType: string,
  chunk: string,
): Promise<{ status: number; body: unknown } | "no-response"> {
  let request: http.ClientRequest | undefined;
  const response = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    request = http.request(`${baseUrl}/internal/openclaw/activity/v1/events`, {
      method: "POST",
      headers: { "content-type": contentType },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (responseChunk: Buffer) => chunks.push(responseChunk));
      incoming.on("end", () => {
        resolve({
          status: incoming.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      });
    });
    request.on("error", reject);
    request.write(chunk);
  });
  const outcome = await Promise.race([
    response,
    new Promise<"no-response">((resolve) => setTimeout(() => resolve("no-response"), 150)),
  ]);
  request?.destroy();
  return outcome;
}

afterEach(() => installActivityIntakeHandler(null));

describe("POST /internal/openclaw/activity/v1/events", () => {
  it("fails retryably while the local runtime registry/handler is not installed", async () => {
    installActivityIntakeHandler(null);
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "runtime_unsynchronized", retryable: true });
    });
  });

  it("owns the bare loopback JSON route and returns the normalized 201 response", async () => {
    const envelope = envelopeWithAttachment();
    const append = vi.fn(async () => ({
      outcome: "persisted" as const,
      postIds: ["post-1"],
      receipt: {
        eventKey: envelope.eventKey,
        postId: "post-1",
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
      },
    }));
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
          attentionMention: "@builder",
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
      await expect(response.json()).resolves.toEqual({
        outcome: "persisted",
        postIds: ["post-1"],
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
      });
    });
  });

  it("parses the one-envelope/one-detail multipart contract and enforces its file limit", async () => {
    const bytes = Buffer.from("eight-bytes");
    const envelope = envelopeWithAttachment(bytes);
    const append = vi.fn(async () => ({
      outcome: "persisted" as const,
      postIds: ["post-1"],
      receipt: {
        eventKey: envelope.eventKey,
        postId: "post-1",
        activityChannelId: "activity-1",
        activityRootPostId: "activity-root-1",
      },
    }));
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
          attentionMention: "@builder",
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

  it("spools multipart detail to a bounded source, validates transport metadata, and cleans it up before responding", async () => {
    const bytes = Buffer.from("streamed detail");
    const envelope = envelopeWithAttachment(bytes);
    let source: ActivityAttachmentSource | undefined;
    let releaseDisposal: (() => void) | undefined;
    const disposalReleased = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    let disposalStarted: (() => void) | undefined;
    const disposalStartedPromise = new Promise<void>((resolve) => {
      disposalStarted = resolve;
    });
    const append = vi.fn(async (input: { attachment?: Uint8Array | ActivityAttachmentSource }) => {
      expect(input.attachment).not.toBeInstanceOf(Uint8Array);
      source = input.attachment as ActivityAttachmentSource;
      expect(source.byteLength).toBe(bytes.byteLength);
      expect(Buffer.from(await source.read(0, 8)).toString("utf8")).toBe("streamed");
      const dispose = source.dispose.bind(source);
      source.dispose = vi.fn(async () => {
        disposalStarted?.();
        await disposalReleased;
        await dispose();
      });
      return {
        outcome: "persisted" as const,
        postIds: ["post-1"],
        receipt: {
          eventKey: envelope.eventKey,
          postId: "post-1",
          activityChannelId: "activity-1",
          activityRootPostId: "activity-root-1",
        },
      };
    });
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
          attentionMention: "@builder",
        })),
      },
      sinkFor: () => ({ append }),
    }, { maxAttachmentBytes: 1024 }));

    await withServer(async (baseUrl, responseEnded) => {
      const form = new FormData();
      form.set("envelope", JSON.stringify(envelope));
      form.set("detail", new Blob([bytes], { type: "text/plain" }), "tool.txt");
      const responsePromise = fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        body: form,
      });
      await disposalStartedPromise;
      expect(responseEnded()).toBe(false);
      releaseDisposal?.();
      const response = await responsePromise;
      expect(response.status).toBe(201);
    });
    await expect(source?.read(0, 1)).rejects.toThrow();
  });

  it("logs an attachment cleanup failure before returning the intake response", async () => {
    const bytes = Buffer.from("streamed detail");
    const envelope = envelopeWithAttachment(bytes);
    const log = vi.fn();
    const append = vi.fn(async (input: { attachment?: Uint8Array | ActivityAttachmentSource }) => {
      const source = input.attachment as ActivityAttachmentSource;
      const dispose = source.dispose.bind(source);
      source.dispose = vi.fn(async () => {
        await dispose();
        throw new Error("temporary attachment cleanup failed");
      });
      return {
        outcome: "persisted" as const,
        postIds: ["post-1"],
        receipt: {
          eventKey: envelope.eventKey,
          postId: "post-1",
          activityChannelId: "activity-1",
          activityRootPostId: "activity-root-1",
        },
      };
    });
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => ({
          ...envelope.ref,
          activityChannelId: "activity-1",
          channelDocPath: "workspaces/acme/channels/build",
          channelCreateAt: 1,
          coachToken: "token",
          attentionMention: "@builder",
        })),
      },
      sinkFor: () => ({ append }),
      log,
    }));

    await withServer(async (baseUrl) => {
      const form = new FormData();
      form.set("envelope", JSON.stringify(envelope));
      form.set("detail", new Blob([bytes], { type: "text/plain" }), "tool.txt");
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        body: form,
      });
      expect(response.status).toBe(201);
    });
    expect(log).toHaveBeenCalledWith("activity_attachment_cleanup_error", {
      error: "temporary attachment cleanup failed",
    });
  });

  it("returns JSON 413 before parsing a declared oversized body", async () => {
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: { readiness: () => "ready", resolve: vi.fn() },
      sinkFor: vi.fn(),
    }));
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
      });
      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ error: "json_too_large", retryable: false });
    });
  });

  it("bounds an incomplete JSON body with a retryable read timeout", async () => {
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: { readiness: () => "ready", resolve: vi.fn() },
      sinkFor: vi.fn(),
    }, { bodyTimeoutMs: 20 }));

    await withServer(async (baseUrl) => {
      const outcome = await sendIncompleteBody(baseUrl, "application/json", "{");
      expect(outcome).toEqual({
        status: 503,
        body: { error: "body_read_timeout", retryable: true },
      });
    });
  });

  it("bounds an incomplete multipart body with the same retryable read timeout", async () => {
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: { readiness: () => "ready", resolve: vi.fn() },
      sinkFor: vi.fn(),
    }, { bodyTimeoutMs: 20 }));

    await withServer(async (baseUrl) => {
      const outcome = await sendIncompleteBody(
        baseUrl,
        "multipart/form-data; boundary=octogee",
        '--octogee\r\nContent-Disposition: form-data; name="envelope"\r\n\r\n{',
      );
      expect(outcome).toEqual({
        status: 503,
        body: { error: "body_read_timeout", retryable: true },
      });
    });
  });

  it("logs the original unexpected intake error before returning a generic retryable response", async () => {
    const log = vi.fn();
    const envelope = envelopeWithAttachment();
    installActivityIntakeHandler(createActivityIntakeHttpHandler({
      registry: {
        readiness: () => "ready",
        resolve: vi.fn(async () => {
          throw new Error("runtime database exploded");
        }),
      },
      sinkFor: vi.fn(),
      log,
    }));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/internal/openclaw/activity/v1/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "activity_intake_unavailable",
        retryable: true,
      });
    });
    expect(log).toHaveBeenCalledWith("activity_intake_error", expect.objectContaining({
      error: "runtime database exploded",
    }));
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
