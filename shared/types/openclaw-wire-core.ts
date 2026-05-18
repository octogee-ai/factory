/**
 * Canonical OpenClaw WS wire layer — the one implementation of the
 * connect-challenge nonce tracker, the WS-open wait, the request/response
 * framing, the response-frame guard, AND the error type. Previously each
 * in-pod client (scripts/lib/gateway-rpc.ts, chat-proxy/src/openclaw/
 * upstream.ts) owned a private copy of all of this plus its own error
 * class — duplicated code on the live gateway handshake path that drifted
 * and bit TEST twice.
 *
 * We own every caller (pre-customer), so rather than preserve the
 * accidental subset/superset split behind a factory indirection, both
 * clients use this single `OpenclawWireError`. Its taxonomy is the
 * superset the provisioner's config-patch retry machine
 * (scripts/lib/apply-config-patch.ts) depends on — kept verbatim, so the
 * scripts side has zero behaviour change. chat-proxy adopts it; its only
 * delta is log text + the `!ok` code on a path its callers don't branch
 * on.
 *
 * Dependency-free (structural socket, no `ws` import, no Buffer/Node
 * globals) so it is safe for the barrel + app's stricter typecheck.
 *
 * Spec: docs/specs/CHAT-PROXY-SHARED-IMPORTS-SPEC.md (Stage 3).
 */

export type OpenclawWireErrorCode =
  | "connect-failed"
  | "auth-failed"
  | "hash-mismatch"
  | "invalid-patch"
  | "timeout"
  | "invalid-response"
  | "rpc-error";

export class OpenclawWireError extends Error {
  override readonly name = "OpenclawWireError";
  constructor(
    readonly code: OpenclawWireErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Minimal structural view of a `ws` WebSocket — the subset the wire
 * mechanics touch. The real `ws.WebSocket` is structurally assignable. */
export interface WireSocket {
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  send(data: string): void;
  terminate(): void;
}

/** Binary frames arrive as something with `.toString("utf-8")` (a Node
 * Buffer at runtime) — typed structurally so shared/ needs no Buffer. */
interface Utf8Decodable {
  toString(encoding?: string): string;
}

export interface ResponseFrame {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export function isResponseFrame(v: unknown): v is ResponseFrame {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { type?: unknown }).type === "res" &&
    typeof (v as { id?: unknown }).id === "string" &&
    typeof (v as { ok?: unknown }).ok === "boolean"
  );
}

/**
 * `ws` delivers a frame as string | Buffer | ArrayBuffer | Buffer[]
 * (RawData). The original duplicated copies only handled string|Buffer —
 * an ArrayBuffer/fragmented frame silently failed to parse and timed out.
 * Decoded dependency-free (TextDecoder, no Buffer global) so the module
 * stays barrel/app-safe.
 */
function frameToString(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) {
    return new TextDecoder("utf-8").decode(new Uint8Array(data));
  }
  if (Array.isArray(data)) {
    const parts = data.map(frameToString);
    return parts.some((p) => p === undefined)
      ? undefined
      : parts.join("");
  }
  if (data && typeof (data as Utf8Decodable).toString === "function") {
    return (data as Utf8Decodable).toString("utf-8");
  }
  return undefined;
}

function parseFrame(data: unknown): unknown {
  const s = frameToString(data);
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function waitForWsOpen(
  ws: WireSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* */
      }
      reject(
        new OpenclawWireError(
          "connect-failed",
          `WS open timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (...args: unknown[]) => {
      cleanup();
      try {
        ws.terminate();
      } catch {
        /* */
      }
      reject(
        new OpenclawWireError(
          "connect-failed",
          `WS open failed: ${(args[0] as Error).message}`,
        ),
      );
    };
    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
    }
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
}

export function startConnectChallengeTracker(ws: WireSocket): {
  wait: (timeoutMs: number) => Promise<string>;
} {
  let cached: string | null = null;
  let pendingResolve: ((nonce: string) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  const onMessage = (...args: unknown[]) => {
    if (cached !== null) return;
    const parsed = parseFrame(args[0]);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { type?: unknown }).type !== "event" ||
      (parsed as { event?: unknown }).event !== "connect.challenge"
    ) {
      return;
    }
    const nonce = (parsed as { payload?: { nonce?: unknown } }).payload?.nonce;
    if (typeof nonce !== "string" || nonce.length === 0) {
      if (pendingReject) {
        pendingReject(
          new OpenclawWireError(
            "invalid-response",
            "connect.challenge event has no string nonce",
          ),
        );
      }
      return;
    }
    cached = nonce;
    if (pendingResolve) pendingResolve(nonce);
  };
  ws.on("message", onMessage);

  return {
    wait(timeoutMs: number): Promise<string> {
      if (cached !== null) return Promise.resolve(cached);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new OpenclawWireError(
              "connect-failed",
              `connect.challenge not received within ${timeoutMs}ms`,
            ),
          );
        }, timeoutMs);
        const onClose = () => {
          cleanup();
          reject(
            new OpenclawWireError(
              "connect-failed",
              "socket closed before connect.challenge arrived",
            ),
          );
        };
        pendingResolve = (nonce) => {
          cleanup();
          resolve(nonce);
        };
        pendingReject = (err) => {
          cleanup();
          reject(err);
        };
        function cleanup() {
          clearTimeout(timer);
          ws.removeListener("close", onClose);
          pendingResolve = null;
          pendingReject = null;
        }
        ws.on("close", onClose);
      });
    },
  };
}

export function sendWsRequest(
  ws: WireSocket,
  id: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  mapConnectErrors = false,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new OpenclawWireError(
          "timeout",
          `${method} response timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);

    const onMessage = (...args: unknown[]) => {
      const parsed = parseFrame(args[0]);
      if (!isResponseFrame(parsed) || parsed.id !== id) return;
      cleanup();
      if (parsed.ok) {
        resolve(parsed.payload);
        return;
      }
      const serverCode = parsed.error?.code ?? "UNKNOWN";
      const errMsg = parsed.error?.message ?? "gateway error";
      reject(
        new OpenclawWireError(
          mapConnectErrors ? "auth-failed" : "rpc-error",
          errMsg,
          { serverCode, details: parsed.error?.details },
        ),
      );
    };
    const onClose = () => {
      cleanup();
      reject(
        new OpenclawWireError(
          "connect-failed",
          `socket closed before ${method} response`,
        ),
      );
    };
    const onError = (...args: unknown[]) => {
      cleanup();
      reject(
        new OpenclawWireError(
          "connect-failed",
          `socket error during ${method}: ${(args[0] as Error).message}`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timer);
      ws.removeListener("message", onMessage);
      ws.removeListener("close", onClose);
      ws.removeListener("error", onError);
    }

    ws.on("message", onMessage);
    ws.on("close", onClose);
    ws.on("error", onError);
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}
