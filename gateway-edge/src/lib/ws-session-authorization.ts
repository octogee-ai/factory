export const DEFAULT_SESSION_AUTHORIZATION_INTERVAL_MS = 10_000;
export const DEFAULT_SESSION_AUTHORIZATION_TIMEOUT_MS = 5_000;

export type SessionAuthorization = "allowed" | "revoked" | "unavailable";

export interface ReauthorizableSession {
  reauthorize(): Promise<boolean>;
}

export async function authorizeSession(
  session: ReauthorizableSession,
  timeoutMs: number,
): Promise<SessionAuthorization> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const authorized = await Promise.race([
      session.reauthorize(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("session authorization timed out")), timeoutMs);
        timer.unref();
      }),
    ]);
    return authorized ? "allowed" : "revoked";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export function monitorSessionAuthorization(
  session: ReauthorizableSession,
  options: {
    intervalMs: number;
    timeoutMs: number;
    onEnded: (result: Exclude<SessionAuthorization, "allowed">) => void;
  },
): () => void {
  let stopped = false;
  let pending = false;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = true;
    void authorizeSession(session, options.timeoutMs).then((result) => {
      pending = false;
      if (stopped || result === "allowed") return;
      options.onEnded(result);
    });
  }, options.intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
