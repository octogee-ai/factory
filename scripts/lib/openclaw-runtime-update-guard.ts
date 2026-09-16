const WAIT_TIMEOUT_MS = 60_000;

export class OpenClawRuntimeUpdateGuard {
  private active: Promise<void> | null = null;
  private waiting = 0;

  tryRun<T>(operation: () => Promise<T>): Promise<T> | undefined {
    if (this.active || this.waiting > 0) return undefined;
    return this.start(operation);
  }

  async run<T>(operation: () => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const deadline = Date.now() + (options.timeoutMs ?? WAIT_TIMEOUT_MS);
    this.waiting += 1;
    try {
      options.signal?.throwIfAborted();
      while (this.active) await this.wait(this.active, deadline, options.signal);
      options.signal?.throwIfAborted();
      return this.start(operation);
    } finally {
      this.waiting -= 1;
    }
  }

  private start<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const active = new Promise<void>((resolve) => { release = resolve; });
    this.active = active;
    return Promise.resolve().then(operation).finally(() => {
      if (this.active === active) this.active = null;
      release();
    });
  }

  private wait(active: Promise<void>, deadline: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("OpenClaw runtime update cancelled"));
      const timer = setTimeout(() => finish(new Error("Timed out waiting for an OpenClaw runtime update")),
        Math.max(0, deadline - Date.now()));
      signal?.addEventListener("abort", abort, { once: true });
      void active.then(() => finish());
    });
  }
}

export const openClawRuntimeUpdateGuard = new OpenClawRuntimeUpdateGuard();
