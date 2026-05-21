import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

export interface UpstreamRpcClient {
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: T } | { ok: false; reason: string }>;
  dispose(): void;
}

export interface AttachUpstreamRpcOptions {
  timeoutMs?: number;
}

interface PendingCall {
  resolve: (v: { ok: true; result: unknown } | { ok: false; reason: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function attachUpstreamRpcClient(
  ws: WebSocket,
  opts: AttachUpstreamRpcOptions = {},
): UpstreamRpcClient {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const inFlight = new Map<string, PendingCall>();
  let disposed = false;

  const onMessage = (data: unknown): void => {
    let raw: string;
    if (typeof data === "string") {
      raw = data;
    } else if (data && typeof (data as { toString?: () => string }).toString === "function") {
      raw = (data as { toString: () => string }).toString();
    } else {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const env = parsed as { type?: unknown; id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
    if (env.type !== "response" || typeof env.id !== "string") return;
    const pending = inFlight.get(env.id);
    if (!pending) return;
    inFlight.delete(env.id);
    clearTimeout(pending.timer);
    if (env.ok === true) {
      pending.resolve({ ok: true, result: env.result });
    } else {
      const errMsg =
        env.error && typeof env.error === "object" && typeof (env.error as { message?: unknown }).message === "string"
          ? (env.error as { message: string }).message
          : String(env.error ?? "rpc error");
      pending.resolve({ ok: false, reason: errMsg });
    }
  };

  const onClose = (): void => {
    for (const [id, pending] of inFlight.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "upstream-ws-closed" });
      inFlight.delete(id);
    }
  };

  ws.on("message", onMessage);
  ws.on("close", onClose);

  const call = async <T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; result: T } | { ok: false; reason: string }> => {
    if (disposed) {
      return { ok: false, reason: "client-disposed" };
    }
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (inFlight.has(id)) {
          inFlight.delete(id);
          resolve({ ok: false, reason: `rpc-timeout after ${timeoutMs}ms (${method})` });
        }
      }, timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      inFlight.set(id, {
        resolve: resolve as PendingCall["resolve"],
        timer,
      });
      try {
        ws.send(
          JSON.stringify({
            type: "request",
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        inFlight.delete(id);
        clearTimeout(timer);
        resolve({
          ok: false,
          reason: `rpc-send-failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const [id, pending] of inFlight.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, reason: "client-disposed" });
      inFlight.delete(id);
    }
    try {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    } catch {
      /* */
    }
  };

  return { call, dispose };
}
