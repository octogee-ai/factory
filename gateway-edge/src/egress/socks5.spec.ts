import net, { type AddressInfo, type Server, type Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSocks5Server, EgressDialError, parseConnectRequest, parseGreeting, type EgressDialer } from "./socks5.js";
import { SOCKS_REPLY } from "./protocol.js";

const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function echoDuplex(): Duplex {
  const echo = new PassThrough();
  return echo;
}

async function listen(dial: EgressDialer, options: { handshakeTimeoutMs?: number; dialTimeoutMs?: number } = {}): Promise<number> {
  return (await listenServer(dial, options)).port;
}

async function listenServer(dial: EgressDialer, options: { handshakeTimeoutMs?: number; dialTimeoutMs?: number } = {}) {
  const server = createSocks5Server({ dial, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

async function connect(port: number): Promise<Socket> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  await once(socket, "connect");
  return socket;
}

async function read(socket: Socket, length: number): Promise<Buffer> {
  let collected = Buffer.alloc(0);
  while (collected.length < length) {
    const [chunk] = (await once(socket, "data")) as [Buffer];
    collected = Buffer.concat([collected, chunk]);
  }
  return collected;
}

async function handshake(socket: Socket): Promise<void> {
  socket.write(Buffer.from([5, 1, 0]));
  expect(await read(socket, 2)).toEqual(Buffer.from([5, 0]));
}

function connectRequest(host: string, port: number): Buffer {
  const name = Buffer.from(host, "latin1");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]);
}

describe("SOCKS5 listener", () => {
  it("negotiates no-auth, hands CONNECT targets to the dialer and relays bytes both ways", async () => {
    const dial = vi.fn(async () => echoDuplex());
    const socket = await connect(await listen(dial));
    await handshake(socket);
    socket.write(connectRequest("ifconfig.me", 443));
    expect(await read(socket, 10)).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    expect(dial).toHaveBeenCalledWith("ifconfig.me", 443, expect.any(AbortSignal));
    socket.write("GET / HTTP/1.1\r\n");
    expect((await read(socket, 16)).toString()).toBe("GET / HTTP/1.1\r\n");
  });

  it("lets the dial deadline, not the handshake deadline, govern a slow outbound connect", async () => {
    const dial = vi.fn(() => new Promise<Duplex>((resolve) => setTimeout(() => resolve(echoDuplex()), 80)));
    const socket = await connect(await listen(dial, { handshakeTimeoutMs: 30, dialTimeoutMs: 1_000 }));
    await handshake(socket);
    socket.write(connectRequest("slow.example", 443));
    expect(await read(socket, 10)).toEqual(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    socket.write("ping");
    expect((await read(socket, 4)).toString()).toBe("ping");
  });

  it("passes literal IPv4 and IPv6 targets through as addresses", async () => {
    const dial = vi.fn(async () => echoDuplex());
    const port = await listen(dial);
    const v4 = await connect(port);
    await handshake(v4);
    v4.write(Buffer.from([5, 1, 0, 1, 93, 184, 216, 34, 0, 80]));
    await read(v4, 10);
    const v6 = await connect(port);
    await handshake(v6);
    v6.write(Buffer.concat([Buffer.from([5, 1, 0, 4]), Buffer.from("26064700470000000000000000001111", "hex"), Buffer.from([1, 187])]));
    await read(v6, 10);
    expect(dial.mock.calls.map((call) => call.slice(0, 2))).toEqual([["93.184.216.34", 80], ["2606:4700:4700:0:0:0:0:1111", 443]]);
  });

  it("answers a refused dial with that SOCKS reply and closes without relaying", async () => {
    const socket = await connect(await listen(async () => { throw new EgressDialError(SOCKS_REPLY.generalFailure, "no shell"); }));
    await handshake(socket);
    socket.write(connectRequest("ifconfig.me", 443));
    expect(await read(socket, 10)).toEqual(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
    await once(socket, "close");
  });

  it("maps dialer socket errors to SOCKS replies", async () => {
    const refused = Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    const socket = await connect(await listen(async () => { throw refused; }));
    await handshake(socket);
    socket.write(connectRequest("localhost-ish.example", 8080));
    expect((await read(socket, 10))[1]).toBe(SOCKS_REPLY.connectionRefused);
  });

  it("rejects clients that cannot do no-auth and commands other than CONNECT", async () => {
    const dial = vi.fn(async () => echoDuplex());
    const port = await listen(dial);
    const authOnly = await connect(port);
    authOnly.write(Buffer.from([5, 1, 2]));
    expect(await read(authOnly, 2)).toEqual(Buffer.from([5, 0xff]));
    await once(authOnly, "close");
    const bind = await connect(port);
    await handshake(bind);
    bind.write(Buffer.from([5, 2, 0, 1, 127, 0, 0, 1, 0, 80]));
    expect((await read(bind, 10))[1]).toBe(SOCKS_REPLY.commandNotSupported);
    const udp = await connect(port);
    await handshake(udp);
    udp.write(Buffer.from([5, 3, 0, 1, 127, 0, 0, 1, 0, 80]));
    expect((await read(udp, 10))[1]).toBe(SOCKS_REPLY.commandNotSupported);
    expect(dial).not.toHaveBeenCalled();
  });

  it("times out a dial that never settles as host unreachable, aborts it, and destroys a socket that arrives late", async () => {
    let aborted = false;
    const late = echoDuplex();
    const socket = await connect(await listen((_host, _port, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => { aborted = true; });
      setTimeout(() => resolve(late), 60);
    }), { dialTimeoutMs: 20 }));
    await handshake(socket);
    socket.write(connectRequest("slow.example", 443));
    expect((await read(socket, 10))[1]).toBe(SOCKS_REPLY.hostUnreachable);
    expect(aborted).toBe(true);
    await vi.waitFor(() => expect(late.destroyed).toBe(true));
  });

  it("reports an aborted dial as host unreachable without a second reply", async () => {
    const socket = await connect(await listen((_host, _port, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
    }), { dialTimeoutMs: 20 }));
    await handshake(socket);
    socket.write(connectRequest("slow.example", 443));
    expect((await read(socket, 10))[1]).toBe(SOCKS_REPLY.hostUnreachable);
    await once(socket, "close");
  });

  it("terminates every live relay and its upstream on demand, so clients reconnect through the current route", async () => {
    const upstream = echoDuplex();
    const { server, port } = await listenServer(async () => upstream);
    const socket = await connect(port);
    await handshake(socket);
    socket.write(connectRequest("ifconfig.me", 443));
    await read(socket, 10);
    const idle = await connect(port);
    await handshake(idle);
    const closed = Promise.all([once(socket, "close"), once(idle, "close")]);
    expect(server.terminateRelays()).toBe(2);
    await closed;
    expect(upstream.destroyed).toBe(true);
    expect(server.terminateRelays()).toBe(0);
  });

  it("parses greetings and requests incrementally", () => {
    expect(parseGreeting(Buffer.from([5]))).toEqual({ status: "need-more" });
    expect(parseGreeting(Buffer.from([4, 1, 0]))).toMatchObject({ status: "invalid" });
    expect(parseConnectRequest(Buffer.from([5, 1, 0, 3, 11, 105]))).toEqual({ status: "need-more" });
    expect(parseConnectRequest(Buffer.from([5, 1, 0, 3, 0, 0, 80]))).toMatchObject({ status: "invalid" });
    expect(parseConnectRequest(Buffer.from([5, 1, 0, 9, 0, 0, 80]))).toEqual({ status: "reply", reply: SOCKS_REPLY.addressTypeNotSupported });
    expect(parseConnectRequest(Buffer.from([5, 1, 0, 1, 10, 0, 0, 1, 0, 0]))).toMatchObject({ status: "invalid" });
    expect(parseConnectRequest(Buffer.concat([connectRequest("a.example", 80), Buffer.from([1, 2])]))).toEqual({ status: "done", value: { host: "a.example", port: 80 }, rest: Buffer.from([1, 2]) });
  });
});
