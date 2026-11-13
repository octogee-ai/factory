import { Duplex } from "node:stream";
import { decodeEgressFrame, EGRESS_CLOSE_REPLACED, encodeEgressFrame, EGRESS_DATA_CHUNK_BYTES, SOCKS_REPLY, type EgressFrame } from "./protocol.js";
import { EgressDialError } from "./socks5.js";

export interface TunnelSocket {
  readyState: number;
  bufferedAmount: number;
  send(data: Uint8Array, cb?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface EgressTunnelHost {
  attach(socket: TunnelSocket): void;
  detach(code: number, reason: string): void;
  connected(): boolean;
  streamCount(): number;
  dial(host: string, port: number, signal?: AbortSignal): Promise<Duplex>;
  onChange(listener: () => void): () => void;
}

export interface EgressTunnelHostOptions {
  openTimeoutMs?: number;
  maxStreams?: number;
  streamHighWaterMark?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const WS_OPEN = 1;
const MAX_STREAM_ID = 0xffffffff;

interface Session {
  socket: TunnelSocket;
  streams: Map<number, TunnelStream>;
  pending: Map<number, { resolve(stream: TunnelStream): void; reject(error: Error): void; timer: NodeJS.Timeout }>;
  nextId: number;
  closed: boolean;
}

class TunnelStream extends Duplex {
  private peerPaused = false;
  private localPaused = false;
  private closedByPeer = false;
  private peerReset = false;
  private finalSent = false;
  private held: { chunk: Buffer; cb: (error?: Error | null) => void } | null = null;

  constructor(readonly id: number, private readonly session: Session, highWaterMark: number) {
    super({ highWaterMark, allowHalfOpen: true });
  }

  private send(frame: EgressFrame, cb?: (error?: Error) => void): void {
    if (this.session.closed || this.session.socket.readyState !== WS_OPEN) { cb?.(new Error("desktop disconnected")); return; }
    this.session.socket.send(encodeEgressFrame(frame), cb);
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (this.peerPaused) { this.held = { chunk, cb }; return; }
    let offset = 0;
    while (offset < chunk.length) {
      const end = Math.min(offset + EGRESS_DATA_CHUNK_BYTES, chunk.length);
      const last = end >= chunk.length;
      this.send({ type: "data", id: this.id, data: chunk.subarray(offset, end) }, last ? (error) => cb(error ?? null) : undefined);
      offset = end;
    }
    if (chunk.length === 0) cb(null);
  }

  override _read(): void {
    if (!this.localPaused) return;
    this.localPaused = false;
    this.send({ type: "resume", id: this.id });
  }

  override _final(cb: (error?: Error | null) => void): void {
    this.finalSent = true;
    this.send({ type: "close", id: this.id });
    cb(null);
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    if (!this.peerReset && !(this.closedByPeer && this.finalSent)) this.send({ type: "reset", id: this.id });
    this.session.streams.delete(this.id);
    if (this.held) { const held = this.held; this.held = null; held.cb(error ?? new Error("stream destroyed")); }
    cb(error);
  }

  receive(frame: EgressFrame): void {
    switch (frame.type) {
      case "data":
        if (!this.push(Buffer.from(frame.data)) && !this.localPaused) { this.localPaused = true; this.send({ type: "pause", id: this.id }); }
        return;
      case "close":
        this.closedByPeer = true;
        this.push(null);
        return;
      case "reset":
        this.peerReset = true;
        this.destroy();
        return;
      case "pause":
        this.peerPaused = true;
        return;
      case "resume": {
        this.peerPaused = false;
        const held = this.held;
        this.held = null;
        if (held) this._write(held.chunk, "binary", held.cb);
        return;
      }
      default:
        return;
    }
  }
}

function toBytes(data: Buffer | ArrayBuffer | Buffer[]): Uint8Array {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return new Uint8Array(data);
}

export function createEgressTunnelHost(options: EgressTunnelHostOptions = {}): EgressTunnelHost {
  const openTimeoutMs = options.openTimeoutMs ?? 30_000;
  const maxStreams = options.maxStreams ?? 512;
  const highWaterMark = options.streamHighWaterMark ?? 256 * 1024;
  const log = options.log ?? (() => {});
  const listeners = new Set<() => void>();
  let current: Session | null = null;

  const notify = () => { for (const listener of listeners) listener(); };

  const endSession = (session: Session, reason: string) => {
    if (session.closed) return;
    session.closed = true;
    for (const [, pending] of session.pending) { clearTimeout(pending.timer); pending.reject(new EgressDialError(SOCKS_REPLY.generalFailure, reason)); }
    session.pending.clear();
    for (const stream of [...session.streams.values()]) stream.destroy();
    session.streams.clear();
    if (current === session) { current = null; notify(); }
  };

  const receive = (session: Session, frame: EgressFrame) => {
    const pending = session.pending.get(frame.id);
    if (pending) {
      if (frame.type === "opened") {
        clearTimeout(pending.timer);
        session.pending.delete(frame.id);
        pending.resolve(session.streams.get(frame.id)!);
      } else if (frame.type === "refused") {
        clearTimeout(pending.timer);
        session.pending.delete(frame.id);
        session.streams.delete(frame.id);
        pending.reject(new EgressDialError(frame.reason, frame.message || "refused by the desktop"));
      }
      return;
    }
    const stream = session.streams.get(frame.id);
    if (stream) stream.receive(frame);
  };

  return {
    attach(socket) {
      const previous = current;
      const session: Session = { socket, streams: new Map(), pending: new Map(), nextId: 1, closed: false };
      current = session;
      socket.on("message", (data, isBinary) => {
        if (session.closed) return;
        let frame: EgressFrame;
        try {
          if (!isBinary) throw new Error("text frame");
          frame = decodeEgressFrame(toBytes(data));
          if (frame.type === "open") throw new Error("open from desktop");
        } catch (error) {
          log("egress tunnel protocol violation", { error: error instanceof Error ? error.message : String(error) });
          socket.close(1008, "Invalid egress frame");
          endSession(session, "egress protocol violation");
          return;
        }
        receive(session, frame);
      });
      socket.on("close", () => endSession(session, "desktop disconnected"));
      socket.on("error", (error) => { log("egress tunnel socket failed", { error: error.message }); endSession(session, "desktop socket failed"); });
      if (previous) {
        previous.socket.close(EGRESS_CLOSE_REPLACED, "Replaced by a newer desktop connection");
        endSession(previous, "replaced by a newer desktop connection");
      }
      notify();
    },
    detach(code, reason) {
      const session = current;
      if (!session) return;
      session.socket.close(code, reason);
      endSession(session, reason);
    },
    connected: () => current !== null && !current.closed,
    streamCount: () => current?.streams.size ?? 0,
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dial(host, port, signal) {
      const session = current;
      if (!session || session.closed || session.socket.readyState !== WS_OPEN) {
        return Promise.reject(new EgressDialError(SOCKS_REPLY.generalFailure, "desktop egress is not connected"));
      }
      if (session.streams.size >= maxStreams) return Promise.reject(new EgressDialError(SOCKS_REPLY.generalFailure, "too many desktop egress streams"));
      let id = session.nextId;
      while (session.streams.has(id)) id = id >= MAX_STREAM_ID ? 1 : id + 1;
      session.nextId = id >= MAX_STREAM_ID ? 1 : id + 1;
      const stream = new TunnelStream(id, session, highWaterMark);
      session.streams.set(id, stream);
      return new Promise<Duplex>((resolve, reject) => {
        const abandon = (reason: string) => {
          if (!session.pending.has(id)) return;
          clearTimeout(timer);
          session.pending.delete(id);
          session.streams.delete(id);
          if (session.socket.readyState === WS_OPEN) session.socket.send(encodeEgressFrame({ type: "reset", id }));
          reject(new EgressDialError(SOCKS_REPLY.hostUnreachable, reason));
        };
        const timer = setTimeout(() => abandon("desktop did not answer the open in time"), openTimeoutMs);
        timer.unref();
        const onAbort = () => abandon("dial aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
        session.pending.set(id, {
          resolve: (stream) => { signal?.removeEventListener("abort", onAbort); resolve(stream); },
          reject: (error) => { signal?.removeEventListener("abort", onAbort); reject(error); },
          timer,
        });
        session.socket.send(encodeEgressFrame({ type: "open", id, host, port }));
      });
    },
  };
}
