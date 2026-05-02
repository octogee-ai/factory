/**
 * bridge-upstream-rpc.spec.ts — composition test for the bridge's
 * upstream-WS RPC dispatch.
 *
 * The activity bridge dispatches typed approval RPCs (exec.approval.resolve
 * / plugin.approval.resolve) to OC over the same gateway WebSocket it
 * subscribes to for `agent` events. This test verifies the request/response
 * correlation: send → match by id → resolve / reject.
 *
 * Without this wiring, every Approve click in MM dispatches to chat-proxy,
 * passes HMAC + IP + owner checks, then 502s with reason
 * "bridge-not-connected-to-upstream". Tests prevent that regression.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachUpstreamRpcClient,
  type UpstreamRpcClient,
} from "../openclaw/bridge-upstream-rpc.js";

// Minimal WebSocket-like stub. Mirrors only the surface the rpc client uses.
class FakeWs extends EventEmitter {
  readyState = 1; // OPEN
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  // Helper for tests to simulate gateway responses.
  simulateMessage(data: unknown) {
    this.emit("message", JSON.stringify(data));
  }
}

describe("attachUpstreamRpcClient", () => {
  let ws: FakeWs;
  let client: UpstreamRpcClient;

  beforeEach(() => {
    ws = new FakeWs();
    client = attachUpstreamRpcClient(ws as unknown as import("ws").WebSocket);
  });

  afterEach(() => {
    client.dispose();
  });

  it("sends a JSON-RPC request envelope when call() is invoked", async () => {
    const promise = client.call("exec.approval.resolve", {
      approvalId: "appr-1",
      decision: "approved",
      resolvedBy: "@bob",
    });
    expect(ws.sent.length).toBe(1);
    const sent = JSON.parse(ws.sent[0]);
    expect(sent).toMatchObject({
      type: "request",
      method: "exec.approval.resolve",
      params: { approvalId: "appr-1" },
    });
    expect(typeof sent.id).toBe("string");

    // Simulate the matching response.
    ws.simulateMessage({ type: "response", id: sent.id, ok: true, result: { ok: true } });
    const result = await promise;
    expect(result).toEqual({ ok: true, result: { ok: true } });
  });

  it("rejects via the returned ok:false shape on response.ok === false", async () => {
    const promise = client.call("plugin.approval.resolve", { approvalId: "appr-2", decision: "denied" });
    const sentId = JSON.parse(ws.sent[0]).id;
    ws.simulateMessage({ type: "response", id: sentId, ok: false, error: { message: "no such approval" } });
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("no such approval") });
  });

  it("times out after the configured window if no response arrives", async () => {
    const fastClient = attachUpstreamRpcClient(ws as unknown as import("ws").WebSocket, {
      timeoutMs: 30,
    });
    const result = await fastClient.call("exec.approval.resolve", { approvalId: "appr-3" });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("timeout") });
    fastClient.dispose();
  });

  it("ignores response envelopes whose id doesn't match any in-flight call (no crash)", async () => {
    const promise = client.call("exec.approval.resolve", { approvalId: "appr-4" });
    ws.simulateMessage({ type: "response", id: "unrelated-id", ok: true, result: {} });
    // Real response still resolves the original call.
    const sentId = JSON.parse(ws.sent[0]).id;
    ws.simulateMessage({ type: "response", id: sentId, ok: true, result: {} });
    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("ignores non-response frames (e.g. agent events bound for another consumer)", async () => {
    ws.simulateMessage({ type: "event", event: "agent", payload: { runId: "r" } });
    ws.simulateMessage("not-json"); // no crash
    // No in-flight calls — this is just a "doesn't blow up" assertion.
    expect(true).toBe(true);
  });

  it("dispose() clears in-flight calls (returns timeout-shape rejection)", async () => {
    const promise = client.call("exec.approval.resolve", { approvalId: "appr-5" });
    client.dispose();
    const result = await promise;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("dispose") });
  });

  it("close event on the WS rejects all in-flight calls", async () => {
    const a = client.call("exec.approval.resolve", { approvalId: "a" });
    const b = client.call("plugin.approval.resolve", { approvalId: "b" });
    ws.emit("close");
    await expect(a).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
    await expect(b).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("closed") });
  });
});
