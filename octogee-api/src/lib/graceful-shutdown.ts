export interface ClosableServer {
  close(callback: (error?: Error) => void): unknown;
}

export function createGracefulShutdown({
  server,
  flushPostHog,
  onError,
}: {
  server: ClosableServer;
  flushPostHog?: () => Promise<void>;
  onError(message: string, error: unknown): void;
}): () => Promise<void> {
  let stopping = false;
  return async () => {
    if (stopping) return;
    stopping = true;
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    } catch (error) {
      onError("octogee-api HTTP shutdown failed", error);
    }
    try {
      await flushPostHog?.();
    } catch (error) {
      onError("PostHog shutdown failed", error);
    }
  };
}
