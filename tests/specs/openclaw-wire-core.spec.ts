import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  OpenclawWireError,
  isResponseFrame,
  waitForWsOpen,
  startConnectChallengeTracker,
  sendWsRequest,
  type WireSocket,
} from "../../shared/types/openclaw-wire-core";

/**
 * Pins the one canonical wire layer after collapsing the duplicated
 * copies in scripts/lib/gateway-rpc.ts + chat-proxy/src/openclaw/
 * upstream.ts. Behaviour here IS the contract both clients now inherit;
 * the scripts config-patch retry machine depends on these exact codes.
 */
class FakeSocket extends EventEmitter implements WireSocket {
  sent: string[] = [];
  terminated = false;
  send(d: string) {
    this.sent.push(d);
  }
  terminate() {
    this.terminated = true;
  }
}

const asErr = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e as OpenclawWireError,
  );

describe("isResponseFrame", () => {
  it("accepts a res frame, rejects non-frames", () => {
    expect(isResponseFrame({ type: "res", id: "1", ok: true })).toBe(true);
    expect(isResponseFrame({ type: "event", id: "1", ok: true })).toBe(false);
    expect(isResponseFrame({ type: "res", ok: true })).toBe(false);
    expect(isResponseFrame(null)).toBe(false);
  });
});

describe("sendWsRequest", () => {
  it("sends a req frame and resolves the matching response payload", async () => {
    const ws = new FakeSocket();
    const p = sendWsRequest(ws, "id1", "config.get", { a: 1 }, 1000);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "req",
      id: "id1",
      method: "config.get",
      params: { a: 1 },
    });
    ws.emit("message", JSON.stringify({ type: "res", id: "id1", ok: true, payload: { hash: "h" } }));
    expect(await p).toEqual({ hash: "h" });
  });

  it("decodes ArrayBuffer and fragmented Buffer[] frames (ws RawData)", async () => {
    const ab = new FakeSocket();
    const pa = sendWsRequest(ab, "i", "m", {}, 1000);
    ab.emit(
      "message",
      new TextEncoder().encode(
        JSON.stringify({ type: "res", id: "i", ok: true, payload: "AB" }),
      ).buffer,
    );
    expect(await pa).toBe("AB");

    const frag = new FakeSocket();
    const pf = sendWsRequest(frag, "i", "m", {}, 1000);
    const whole = JSON.stringify({ type: "res", id: "i", ok: true, payload: "F" });
    frag.emit("message", [
      Buffer.from(whole.slice(0, 5)),
      Buffer.from(whole.slice(5)),
    ]);
    expect(await pf).toBe("F");
  });

  it("ignores responses with a different id", async () => {
    const ws = new FakeSocket();
    const p = sendWsRequest(ws, "id1", "m", {}, 50);
    ws.emit("message", JSON.stringify({ type: "res", id: "other", ok: true }));
    const e = await asErr(p);
    expect(e.code).toBe("timeout");
  });

  it("!ok → rpc-error with serverCode+details (normal path)", async () => {
    const ws = new FakeSocket();
    const p = sendWsRequest(ws, "i", "config.patch", {}, 1000);
    ws.emit(
      "message",
      JSON.stringify({ type: "res", id: "i", ok: false, error: { code: "EBAD", message: "boom", details: { x: 1 } } }),
    );
    const e = await asErr(p);
    expect(e).toBeInstanceOf(OpenclawWireError);
    expect(e.code).toBe("rpc-error");
    expect(e.message).toBe("boom");
    expect(e.details).toEqual({ serverCode: "EBAD", details: { x: 1 } });
  });

  it("!ok → auth-failed when mapConnectErrors (the connect frame)", async () => {
    const ws = new FakeSocket();
    const p = sendWsRequest(ws, "i", "connect", {}, 1000, true);
    ws.emit("message", JSON.stringify({ type: "res", id: "i", ok: false, error: { code: "EAUTH", message: "nope" } }));
    const e = await asErr(p);
    expect(e.code).toBe("auth-failed");
    expect(e.message).toBe("nope");
  });

  it("default error message is 'gateway error'", async () => {
    const ws = new FakeSocket();
    const p = sendWsRequest(ws, "i", "m", {}, 1000);
    ws.emit("message", JSON.stringify({ type: "res", id: "i", ok: false }));
    expect((await asErr(p)).message).toBe("gateway error");
  });

  it("socket close / error → connect-failed with method in the message", async () => {
    const c = new FakeSocket();
    const pc = sendWsRequest(c, "i", "channels.status", {}, 1000);
    c.emit("close");
    const ec = await asErr(pc);
    expect(ec.code).toBe("connect-failed");
    expect(ec.message).toBe("socket closed before channels.status response");

    const er = new FakeSocket();
    const pe = sendWsRequest(er, "i", "cron.add", {}, 1000);
    er.emit("error", new Error("ECONNRESET"));
    const ee = await asErr(pe);
    expect(ee.code).toBe("connect-failed");
    expect(ee.message).toBe("socket error during cron.add: ECONNRESET");
  });
});

describe("startConnectChallengeTracker", () => {
  it("resolves the nonce from a connect.challenge event", async () => {
    const ws = new FakeSocket();
    const t = startConnectChallengeTracker(ws);
    ws.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "N" } }));
    expect(await t.wait(1000)).toBe("N");
  });

  it("rejects invalid-response on a blank nonce", async () => {
    const ws = new FakeSocket();
    const t = startConnectChallengeTracker(ws);
    const p = t.wait(1000);
    ws.emit("message", JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "" } }));
    const e = await asErr(p);
    expect(e.code).toBe("invalid-response");
  });

  it("rejects connect-failed on timeout and on socket close", async () => {
    const a = new FakeSocket();
    expect((await asErr(startConnectChallengeTracker(a).wait(20))).code).toBe("connect-failed");
    const b = new FakeSocket();
    const pb = startConnectChallengeTracker(b).wait(1000);
    b.emit("close");
    expect((await asErr(pb)).code).toBe("connect-failed");
  });
});

describe("waitForWsOpen", () => {
  it("resolves on open, connect-failed on error/timeout", async () => {
    const a = new FakeSocket();
    const pa = waitForWsOpen(a, 1000);
    a.emit("open");
    await expect(pa).resolves.toBeUndefined();

    const b = new FakeSocket();
    const pb = waitForWsOpen(b, 1000);
    b.emit("error", new Error("refused"));
    const eb = await asErr(pb);
    expect(eb.code).toBe("connect-failed");
    expect(b.terminated).toBe(true);

    const c = new FakeSocket();
    expect((await asErr(waitForWsOpen(c, 20))).code).toBe("connect-failed");
  });
});
