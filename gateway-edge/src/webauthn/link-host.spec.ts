import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPasskeyLinkHost, type PasskeyLinkSocket } from "./link-host.js";
import { decodePasskeyMessage, encodePasskeyMessage, PASSKEY_CLOSE_REPLACED, type WebAuthnRequest } from "./protocol.js";

class FakeSocket extends EventEmitter implements PasskeyLinkSocket {
  readyState = 1;
  sent: string[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  send(text: string): void { this.sent.push(text); }
  close(code?: number, reason?: string): void { this.closedWith = [code, reason]; this.readyState = 3; this.emit("close"); }
  answer(id: number, credential: Record<string, unknown> = { id: "cred" }): void { this.emit("message", encodePasskeyMessage({ type: "response", id, response: { ok: true, credential } })); }
  requests() { return this.sent.map((text) => decodePasskeyMessage(text)); }
}

const request: WebAuthnRequest = { origin: "https://login.example", rpId: "login.example", kind: "get", options: { challenge: "AQID" } };

describe("passkey link host", () => {
  it("answers at once with NotAllowedError while no desktop is linked", async () => {
    const host = createPasskeyLinkHost();
    expect(host.connected()).toBe(false);
    await expect(host.request(request)).resolves.toEqual({ ok: false, error: expect.objectContaining({ name: "NotAllowedError", message: expect.stringContaining("no desktop") }) });
  });

  it("forwards a request to the linked desktop and resolves with its answer", async () => {
    const host = createPasskeyLinkHost();
    const socket = new FakeSocket();
    host.attach(socket);
    expect(host.connected()).toBe(true);
    const pending = host.request(request);
    expect(socket.requests()).toEqual([{ type: "request", id: 1, request }]);
    socket.answer(1, { id: "cred-1" });
    await expect(pending).resolves.toEqual({ ok: true, credential: { id: "cred-1" } });
  });

  it("reports a platform authenticator only while the linked desktop has said it carries one", () => {
    const host = createPasskeyLinkHost();
    expect(host.platformAuthenticator()).toBe(false);
    const socket = new FakeSocket();
    host.attach(socket);
    expect(host.platformAuthenticator()).toBe(false);
    socket.emit("message", encodePasskeyMessage({ type: "hello", platformAuthenticator: true }));
    expect(host.platformAuthenticator()).toBe(true);
    const plain = new FakeSocket();
    host.attach(plain);
    plain.emit("message", encodePasskeyMessage({ type: "hello", platformAuthenticator: false }));
    expect(host.platformAuthenticator()).toBe(false);
    plain.emit("message", encodePasskeyMessage({ type: "hello", platformAuthenticator: true }));
    plain.emit("close");
    expect(host.platformAuthenticator()).toBe(false);
  });

  it("fails pending requests when the desktop leaves, times out silent ones and caps concurrency", async () => {
    vi.useFakeTimers();
    try {
      const host = createPasskeyLinkHost({ timeoutMs: 1_000, maxInFlight: 1 });
      const socket = new FakeSocket();
      host.attach(socket);
      const silent = host.request(request);
      await expect(host.request(request)).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("too many") } });
      vi.advanceTimersByTime(1_001);
      await expect(silent).resolves.toMatchObject({ ok: false, error: { name: "NotAllowedError", message: expect.stringContaining("did not answer") } });
      const leaving = host.request(request);
      socket.emit("close");
      await expect(leaving).resolves.toMatchObject({ ok: false, error: { message: expect.stringContaining("disconnected") } });
      expect(host.connected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a request on the desktop when its caller aborts, freeing the slot at once", async () => {
    const host = createPasskeyLinkHost({ maxInFlight: 1 });
    const socket = new FakeSocket();
    host.attach(socket);
    const controller = new AbortController();
    const pending = host.request(request, controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { name: "AbortError" } });
    expect(socket.requests().at(-1)).toEqual({ type: "cancel", id: 1 });
    const next = host.request(request);
    expect(socket.requests().at(-1)).toMatchObject({ type: "request", id: 2 });
    socket.answer(2);
    await expect(next).resolves.toMatchObject({ ok: true });
  });

  it("lets a newer desktop replace the old one with a code that tells it to stay off", () => {
    const host = createPasskeyLinkHost();
    const first = new FakeSocket();
    const second = new FakeSocket();
    host.attach(first);
    host.attach(second);
    expect(first.closedWith).toEqual([PASSKEY_CLOSE_REPLACED, "Replaced by a newer desktop connection"]);
    expect(host.connected()).toBe(true);
  });

  it("drops a desktop that sends anything but well-formed answers", () => {
    const log = vi.fn();
    const host = createPasskeyLinkHost({ log });
    const socket = new FakeSocket();
    host.attach(socket);
    socket.emit("message", JSON.stringify({ type: "request", id: 1, request }));
    expect(socket.closedWith).toEqual([1008, "Invalid passkey message"]);
    expect(log).toHaveBeenCalledWith("passkey link protocol violation", expect.any(Object));
    expect(host.connected()).toBe(false);
  });
});
