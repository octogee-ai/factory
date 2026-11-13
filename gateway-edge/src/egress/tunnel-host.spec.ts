import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { decodeEgressFrame, EGRESS_CLOSE_REPLACED, encodeEgressFrame, SOCKS_REPLY, type EgressFrame } from "./protocol.js";
import { EgressDialError } from "./socks5.js";
import { createEgressTunnelHost, type TunnelSocket } from "./tunnel-host.js";

class FakeSocket extends EventEmitter implements TunnelSocket {
  readyState = 1;
  bufferedAmount = 0;
  peer!: FakeSocket;
  sent: EgressFrame[] = [];
  closedWith: [number | undefined, string | undefined] | null = null;
  send(data: Uint8Array, cb?: (error?: Error) => void): void {
    this.sent.push(decodeEgressFrame(data));
    const copy = Buffer.from(data);
    setImmediate(() => { this.peer.emit("message", copy, true); cb?.(); });
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closedWith = [code, reason];
    setImmediate(() => { this.emit("close"); this.peer.readyState = 3; this.peer.emit("close"); });
  }
}
function pair(): { edge: FakeSocket; shell: FakeSocket } {
  const edge = new FakeSocket();
  const shell = new FakeSocket();
  edge.peer = shell;
  shell.peer = edge;
  return { edge, shell };
}
function frames(shell: FakeSocket): EgressFrame[] {
  return shell.sent;
}
async function nextFrame(shell: FakeSocket, type: EgressFrame["type"]): Promise<EgressFrame> {
  for (;;) {
    const [data] = (await once(shell, "message")) as [Buffer];
    const frame = decodeEgressFrame(data);
    if (frame.type === type) return frame;
  }
}
function answer(shell: FakeSocket, frame: EgressFrame): void {
  shell.send(encodeEgressFrame(frame));
}

describe("egress tunnel host", () => {
  it("fails closed with a general SOCKS failure while no desktop is attached", async () => {
    const host = createEgressTunnelHost();
    expect(host.connected()).toBe(false);
    await expect(host.dial("ifconfig.me", 443)).rejects.toMatchObject({ reply: SOCKS_REPLY.generalFailure });
  });

  it("opens a stream over the attached socket and relays data, half-close and flow control in both directions", async () => {
    const host = createEgressTunnelHost({ streamHighWaterMark: 8 });
    const { edge, shell } = pair();
    host.attach(edge);
    expect(host.connected()).toBe(true);
    const opening = host.dial("ifconfig.me", 443);
    const open = await nextFrame(shell, "open");
    expect(open).toEqual({ type: "open", id: 1, host: "ifconfig.me", port: 443 });
    answer(shell, { type: "opened", id: 1 });
    const stream = await opening;
   
    expect(host.streamCount()).toBe(1);

    stream.write(Buffer.from("GET / HTTP/1.1\r\n"));
    const data = await nextFrame(shell, "data");
    expect(Buffer.from((data as { data: Uint8Array }).data).toString()).toBe("GET / HTTP/1.1\r\n");

    answer(shell, { type: "data", id: 1, data: Buffer.from("HTTP/1.1 200 OK\r\n") });
    const [received] = (await once(stream, "data")) as [Buffer];
    expect(received.toString()).toBe("HTTP/1.1 200 OK\r\n");

    stream.pause();
    answer(shell, { type: "data", id: 1, data: Buffer.alloc(16, 1) });
    const pause = await nextFrame(shell, "pause");
    expect(pause).toEqual({ type: "pause", id: 1 });
    stream.resume();
    expect(await nextFrame(shell, "resume")).toEqual({ type: "resume", id: 1 });

    answer(shell, { type: "pause", id: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    const held = vi.fn();
    stream.write(Buffer.from("held"), held);
    await new Promise((resolve) => setImmediate(resolve));
    expect(held).not.toHaveBeenCalled();
    expect(frames(edge).filter((frame) => frame.type === "data")).toHaveLength(1);
    answer(shell, { type: "resume", id: 1 });
    const released = await nextFrame(shell, "data");
    expect(Buffer.from((released as { data: Uint8Array }).data).toString()).toBe("held");

    const finished = Promise.all([once(stream, "end"), once(stream, "close")]);
    stream.end();
    expect(await nextFrame(shell, "close")).toEqual({ type: "close", id: 1 });
    answer(shell, { type: "close", id: 1 });
    await finished;
    expect(host.streamCount()).toBe(0);
    expect(frames(edge).some((frame) => frame.type === "reset")).toBe(false);
  });

  it("surfaces a desktop refusal as that SOCKS reply and a desktop reset as a closed stream", async () => {
    const host = createEgressTunnelHost();
    const { edge, shell } = pair();
    host.attach(edge);
    const refused = host.dial("10.0.0.5", 80);
    const open = await nextFrame(shell, "open");
    answer(shell, { type: "refused", id: open.id, reason: SOCKS_REPLY.notAllowedByRuleset, message: "private destination" });
    await expect(refused).rejects.toMatchObject({ reply: SOCKS_REPLY.notAllowedByRuleset, message: "private destination" });
    expect(host.streamCount()).toBe(0);

    const opening = host.dial("example.com", 80);
    const second = await nextFrame(shell, "open");
    answer(shell, { type: "opened", id: second.id });
    const stream = await opening;
    const closed = once(stream, "close");
    answer(shell, { type: "reset", id: second.id });
    await closed;
    expect(host.streamCount()).toBe(0);
  });

  it("resets a stream the SOCKS client abandons so the desktop closes its TCP socket", async () => {
    const host = createEgressTunnelHost();
    const { edge, shell } = pair();
    host.attach(edge);
    const opening = host.dial("example.com", 80);
    const open = await nextFrame(shell, "open");
    answer(shell, { type: "opened", id: open.id });
    const stream = await opening;
    stream.destroy();
    expect(await nextFrame(shell, "reset")).toEqual({ type: "reset", id: open.id });
  });

  it("drops pending opens and live streams when the desktop disconnects, and reports the change", async () => {
    const host = createEgressTunnelHost();
    const changed = vi.fn();
    host.onChange(changed);
    const { edge, shell } = pair();
    host.attach(edge);
    expect(changed).toHaveBeenCalledTimes(1);
    const opening = host.dial("example.com", 80);
    const open = await nextFrame(shell, "open");
    answer(shell, { type: "opened", id: open.id });
    const stream = await opening;
    const pending = host.dial("example.org", 443);
    await nextFrame(shell, "open");
    const closed = once(stream, "close");
    shell.close(1001, "going away");
    await expect(pending).rejects.toBeInstanceOf(EgressDialError);
    await closed;
    expect(host.connected()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    await expect(host.dial("example.com", 80)).rejects.toMatchObject({ reply: SOCKS_REPLY.generalFailure });
  });

  it("lets a newer desktop connection replace the old one", async () => {
    const host = createEgressTunnelHost();
    const first = pair();
    host.attach(first.edge);
    const opening = host.dial("example.com", 80);
    const open = await nextFrame(first.shell, "open");
    answer(first.shell, { type: "opened", id: open.id });
    const stream = await opening;
    const closed = once(stream, "close");
    const second = pair();
    host.attach(second.edge);
    expect(first.edge.closedWith).toEqual([EGRESS_CLOSE_REPLACED, "Replaced by a newer desktop connection"]);
    await closed;
    expect(host.connected()).toBe(true);
    const next = host.dial("example.net", 443);
    expect(await nextFrame(second.shell, "open")).toMatchObject({ host: "example.net" });
    answer(second.shell, { type: "opened", id: 1 });
    await next;
  });

  it("abandons an open the SOCKS side aborts, resetting it on the desktop", async () => {
    const host = createEgressTunnelHost();
    const { edge, shell } = pair();
    host.attach(edge);
    const controller = new AbortController();
    const dialing = host.dial("slow.example", 443, controller.signal);
    const open = await nextFrame(shell, "open");
    controller.abort();
    await expect(dialing).rejects.toMatchObject({ reply: SOCKS_REPLY.hostUnreachable, message: "dial aborted" });
    expect(await nextFrame(shell, "reset")).toEqual({ type: "reset", id: open.id });
    expect(host.streamCount()).toBe(0);
    answer(shell, { type: "opened", id: open.id });
    await new Promise((resolve) => setImmediate(resolve));
    expect(host.streamCount()).toBe(0);
  });

  it("times out an unanswered open as host unreachable and closes the socket on a protocol violation", async () => {
    const host = createEgressTunnelHost({ openTimeoutMs: 10 });
    const { edge, shell } = pair();
    host.attach(edge);
    await expect(host.dial("slow.example", 443)).rejects.toMatchObject({ reply: SOCKS_REPLY.hostUnreachable });
    expect(host.streamCount()).toBe(0);
    shell.send(encodeEgressFrame({ type: "open", id: 9, host: "evil.example", port: 80 }));
    await once(edge, "close");
    expect(edge.closedWith).toEqual([1008, "Invalid egress frame"]);
    expect(host.connected()).toBe(false);
  });
});
