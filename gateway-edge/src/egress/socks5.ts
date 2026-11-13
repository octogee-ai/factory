import net, { type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { SOCKS_REPLY, type SocksReply } from "./protocol.js";

export class EgressDialError extends Error {
  constructor(readonly reply: SocksReply, message: string) { super(message); this.name = "EgressDialError"; }
}

export type EgressDialer = (host: string, port: number, signal: AbortSignal) => Promise<Duplex>;

export interface Socks5ServerOptions {
  dial: EgressDialer;
  handshakeTimeoutMs?: number;
  dialTimeoutMs?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const SOCKS_VERSION = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_UNACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const MAX_HANDSHAKE_BYTES = 1024;

type Parsed<T> = { status: "need-more" } | { status: "done"; value: T; rest: Buffer } | { status: "invalid"; reason: string };

export function parseGreeting(buffer: Buffer): Parsed<{ noAuth: boolean }> {
  if (buffer.length < 2) return { status: "need-more" };
  if (buffer[0] !== SOCKS_VERSION) return { status: "invalid", reason: "not socks5" };
  const count = buffer[1]!;
  if (buffer.length < 2 + count) return { status: "need-more" };
  const methods = buffer.subarray(2, 2 + count);
  return { status: "done", value: { noAuth: methods.includes(METHOD_NO_AUTH) }, rest: buffer.subarray(2 + count) };
}

export interface SocksConnectRequest { host: string; port: number }
type RequestOutcome = Parsed<SocksConnectRequest> | { status: "reply"; reply: SocksReply };

function ipv6FromBytes(bytes: Buffer): string {
  const groups: string[] = [];
  for (let offset = 0; offset < 16; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
  return groups.join(":");
}

export function parseConnectRequest(buffer: Buffer): RequestOutcome {
  if (buffer.length < 4) return { status: "need-more" };
  if (buffer[0] !== SOCKS_VERSION) return { status: "invalid", reason: "not socks5" };
  if (buffer[1] !== CMD_CONNECT) return { status: "reply", reply: SOCKS_REPLY.commandNotSupported };
  const atyp = buffer[3];
  let host: string;
  let end: number;
  if (atyp === ATYP_IPV4) {
    end = 4 + 4;
    if (buffer.length < end + 2) return { status: "need-more" };
    host = Array.from(buffer.subarray(4, end)).join(".");
  } else if (atyp === ATYP_IPV6) {
    end = 4 + 16;
    if (buffer.length < end + 2) return { status: "need-more" };
    host = ipv6FromBytes(buffer.subarray(4, end));
  } else if (atyp === ATYP_DOMAIN) {
    if (buffer.length < 5) return { status: "need-more" };
    const length = buffer[4]!;
    end = 5 + length;
    if (buffer.length < end + 2) return { status: "need-more" };
    host = buffer.subarray(5, end).toString("latin1");
    if (length === 0 || !/^[\x21-\x7e]+$/u.test(host)) return { status: "invalid", reason: "invalid domain" };
  } else {
    return { status: "reply", reply: SOCKS_REPLY.addressTypeNotSupported };
  }
  const port = buffer.readUInt16BE(end);
  if (port === 0) return { status: "invalid", reason: "port zero" };
  return { status: "done", value: { host, port }, rest: buffer.subarray(end + 2) };
}

export function socksReply(reply: SocksReply): Buffer {
  return Buffer.from([SOCKS_VERSION, reply, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
}

export function socksReplyForError(error: unknown): SocksReply {
  if (error instanceof EgressDialError) return error.reply;
  const code = (error as { code?: string } | null)?.code;
  switch (code) {
    case "ECONNREFUSED": return SOCKS_REPLY.connectionRefused;
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "EAI_NODATA":
    case "EAI_NONAME":
    case "EHOSTUNREACH":
    case "ETIMEDOUT": return SOCKS_REPLY.hostUnreachable;
    case "ENETUNREACH": return SOCKS_REPLY.networkUnreachable;
    default: return SOCKS_REPLY.generalFailure;
  }
}

export async function dialWithDeadline(dial: EgressDialer, host: string, port: number, deadlineMs: number): Promise<Duplex> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  timer.unref();
  try {
    const upstream = await dial(host, port, controller.signal);
    if (controller.signal.aborted) { upstream.destroy(); throw new EgressDialError(SOCKS_REPLY.hostUnreachable, "dial timed out"); }
    return upstream;
  } catch (error) {
    if (controller.signal.aborted) throw new EgressDialError(SOCKS_REPLY.hostUnreachable, "dial timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function relay(client: Socket, upstream: Duplex): void {
  const finish = () => { client.destroy(); upstream.destroy(); };
  client.pipe(upstream).pipe(client);
  client.on("error", finish);
  upstream.on("error", finish);
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
}

export interface Socks5Server extends net.Server {
  terminateRelays(): number;
}

export function createSocks5Server(options: Socks5ServerOptions): Socks5Server {
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
  const dialTimeoutMs = options.dialTimeoutMs ?? 30_000;
  const log = options.log ?? (() => {});
  const clients = new Set<Socket>();
  const server = net.createServer((client) => {
    clients.add(client);
    client.once("close", () => clients.delete(client));
    let buffer = Buffer.alloc(0);
    let phase: "greeting" | "request" | "dialing" | "relaying" = "greeting";
    const timer = setTimeout(() => { if (phase !== "relaying") client.destroy(); }, handshakeTimeoutMs);
    timer.unref();
    client.on("error", () => {});
    client.on("close", () => clearTimeout(timer));

    const reject = (reply: SocksReply) => { client.end(socksReply(reply)); phase = "relaying"; };

    const connect = async (target: SocksConnectRequest) => {
      phase = "dialing";
      clearTimeout(timer);
      client.pause();
      let upstream: Duplex;
      try {
        upstream = await dialWithDeadline(options.dial, target.host, target.port, dialTimeoutMs);
      } catch (error) {
        log("egress dial refused", { host: target.host, port: target.port, error: error instanceof Error ? error.message : String(error) });
        if (!client.destroyed) reject(socksReplyForError(error));
        return;
      }
      if (client.destroyed) { upstream.destroy(); return; }
      phase = "relaying";
      client.write(socksReply(SOCKS_REPLY.succeeded));
      if (buffer.length > 0) upstream.write(buffer);
      buffer = Buffer.alloc(0);
      relay(client, upstream);
      client.resume();
    };

    client.on("data", (chunk: Buffer) => {
      if (phase === "relaying" || phase === "dialing") {
        if (phase === "dialing") buffer = Buffer.concat([buffer, chunk]);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_HANDSHAKE_BYTES) { client.destroy(); return; }
      if (phase === "greeting") {
        const greeting = parseGreeting(buffer);
        if (greeting.status === "need-more") return;
        if (greeting.status === "invalid" || !greeting.value.noAuth) { client.end(Buffer.from([SOCKS_VERSION, METHOD_UNACCEPTABLE])); return; }
        client.write(Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]));
        buffer = Buffer.from(greeting.rest);
        phase = "request";
      }
      if (phase === "request") {
        const request = parseConnectRequest(buffer);
        if (request.status === "need-more") return;
        if (request.status === "invalid") { client.destroy(); return; }
        if (request.status === "reply") { reject(request.reply); return; }
        buffer = Buffer.from(request.rest);
        void connect(request.value);
      }
    });
  });
  return Object.assign(server, {
    terminateRelays(): number {
      const count = clients.size;
      for (const client of [...clients]) client.destroy();
      clients.clear();
      return count;
    },
  });
}
