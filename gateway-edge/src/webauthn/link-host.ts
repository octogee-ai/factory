import { decodePasskeyMessage, encodePasskeyMessage, PASSKEY_CLOSE_REPLACED, WEBAUTHN_TIMEOUT_MS, webAuthnFailure, type WebAuthnRequest, type WebAuthnResponse } from "./protocol.js";

export interface PasskeyLinkSocket {
  readyState: number;
  send(text: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export interface PasskeyLinkHost {
  attach(socket: PasskeyLinkSocket): void;
  request(request: WebAuthnRequest, signal?: AbortSignal): Promise<WebAuthnResponse>;
  connected(): boolean;
  platformAuthenticator(): boolean;
}

export interface PasskeyLinkHostOptions {
  timeoutMs?: number;
  maxInFlight?: number;
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

interface Session {
  socket: PasskeyLinkSocket;
  pending: Map<number, { resolve(response: WebAuthnResponse): void; timer: NodeJS.Timeout }>;
  nextId: number;
  closed: boolean;
  platformAuthenticator: boolean;
}

const WS_OPEN = 1;
const MAX_ID = 0xffffffff;

function text(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  throw new Error("unsupported message payload");
}

export function createPasskeyLinkHost(options: PasskeyLinkHostOptions = {}): PasskeyLinkHost {
  const timeoutMs = options.timeoutMs ?? WEBAUTHN_TIMEOUT_MS;
  const maxInFlight = options.maxInFlight ?? 4;
  const log = options.log ?? (() => {});
  let current: Session | null = null;

  const end = (session: Session, reason: string) => {
    if (session.closed) return;
    session.closed = true;
    for (const [, waiting] of session.pending) {
      clearTimeout(waiting.timer);
      waiting.resolve(webAuthnFailure("NotAllowedError", `the desktop disconnected before answering the passkey request (${reason})`));
    }
    session.pending.clear();
    if (current === session) current = null;
  };

  const receive = (session: Session, data: unknown) => {
    if (session.closed) return;
    let message;
    try {
      message = decodePasskeyMessage(text(data));
      if (message.type !== "response" && message.type !== "hello") throw new Error("request from the desktop");
    } catch (error) {
      log("passkey link protocol violation", { error: error instanceof Error ? error.message : String(error) });
      session.socket.close(1008, "Invalid passkey message");
      end(session, "protocol violation");
      return;
    }
    if (message.type === "hello") { session.platformAuthenticator = message.platformAuthenticator; return; }
    const waiting = session.pending.get(message.id);
    if (!waiting) { log("passkey answer for an unknown request", { id: message.id }); return; }
    clearTimeout(waiting.timer);
    session.pending.delete(message.id);
    waiting.resolve(message.response);
  };

  return {
    attach(socket) {
      const previous = current;
      const session: Session = { socket, pending: new Map(), nextId: 1, closed: false, platformAuthenticator: false };
      current = session;
      socket.on("message", (data) => receive(session, data));
      socket.on("close", () => end(session, "desktop disconnected"));
      socket.on("error", (error) => { log("passkey link socket failed", { error: error.message }); end(session, "desktop socket failed"); });
      if (previous) {
        previous.socket.close(PASSKEY_CLOSE_REPLACED, "Replaced by a newer desktop connection");
        end(previous, "replaced by a newer desktop connection");
      }
    },
    connected: () => current !== null && !current.closed,
    platformAuthenticator: () => current !== null && !current.closed && current.platformAuthenticator,
    request(request, signal) {
      if (signal?.aborted) return Promise.resolve(webAuthnFailure("AbortError", "The passkey request was aborted."));
      const session = current;
      if (!session || session.closed || session.socket.readyState !== WS_OPEN) {
        return Promise.resolve(webAuthnFailure("NotAllowedError", "no desktop is linked to answer passkey requests"));
      }
      if (session.pending.size >= maxInFlight) return Promise.resolve(webAuthnFailure("NotAllowedError", "too many passkey requests are waiting on the desktop"));
      const id = session.nextId;
      session.nextId = id >= MAX_ID ? 1 : id + 1;
      return new Promise<WebAuthnResponse>((resolve) => {
        const onAbort = () => {
          const waiting = session.pending.get(id);
          if (!waiting) return;
          clearTimeout(waiting.timer);
          session.pending.delete(id);
          if (!session.closed && session.socket.readyState === WS_OPEN) session.socket.send(encodePasskeyMessage({ type: "cancel", id }));
          resolve(webAuthnFailure("AbortError", "The passkey request was aborted."));
        };
        const settle = (response: WebAuthnResponse) => { signal?.removeEventListener("abort", onAbort); resolve(response); };
        const timer = setTimeout(() => {
          session.pending.delete(id);
          settle(webAuthnFailure("NotAllowedError", "the desktop did not answer the passkey request in time"));
        }, timeoutMs);
        timer.unref();
        session.pending.set(id, { resolve: settle, timer });
        signal?.addEventListener("abort", onAbort, { once: true });
        session.socket.send(encodePasskeyMessage({ type: "request", id, request }));
      });
    },
  };
}
