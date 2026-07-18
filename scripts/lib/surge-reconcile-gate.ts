export interface StartAfterSurgeReadinessOptions {
  released: () => Promise<boolean>;
  start: () => () => void;
  schedule?: (callback: () => void) => () => void;
  log: (message: string) => void;
}

function defaultSchedule(callback: () => void): () => void {
  const timer = setTimeout(callback, 1_000);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearTimeout(timer);
}

export function startAfterSurgeReadiness(
  opts: StartAfterSurgeReadinessOptions,
): () => void {
  const schedule = opts.schedule ?? defaultSchedule;
  let stopped = false;
  let checking = false;
  let cancelCheck: (() => void) | null = null;
  let stopStarted: (() => void) | null = null;

  const check = async (): Promise<void> => {
    if (stopped || checking || stopStarted) return;
    checking = true;
    try {
      if (await opts.released()) {
        if (!stopped) stopStarted = opts.start();
        return;
      }
    } catch (error) {
      opts.log(
        `[surge-handoff] readiness marker check failed: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      checking = false;
    }
    if (!stopped && !stopStarted) cancelCheck = schedule(() => void check());
  };

  void check();
  return () => {
    stopped = true;
    cancelCheck?.();
    stopStarted?.();
  };
}
