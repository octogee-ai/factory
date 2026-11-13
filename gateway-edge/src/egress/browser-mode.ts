import type { GatewayEgressMode } from "@octogee/shared/types/glm";

export interface BrowserModeSync {
  apply(mode: GatewayEgressMode): void;
}

export interface BrowserModeSyncOptions {
  post(mode: GatewayEgressMode): Promise<void>;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
  retryDelaysMs?: readonly number[];
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class BrowserModeUnsupportedError extends Error {
  constructor(message: string) { super(message); this.name = "BrowserModeUnsupportedError"; }
}

const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export function createBrowserModeSync(options: BrowserModeSyncOptions): BrowserModeSync {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs).unref());
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  let desired: GatewayEgressMode | null = null;
  let busy = false;
  let failures = 0;
  let backoff: { mode: GatewayEgressMode; timer: unknown } | null = null;

  const deliver = () => {
    backoff = null;
    const mode = desired;
    if (mode === null) return;
    busy = true;
    options.post(mode).then(
      () => {
        failures = 0;
        busy = false;
        if (desired !== mode) deliver();
        else desired = null;
      },
      (error: unknown) => {
        if (error instanceof BrowserModeUnsupportedError) {
          busy = false;
          failures = 0;
          options.logger.error("computer browser cannot follow the egress mode on this desktop image", { mode, error: error.message });
          if (desired !== mode) deliver();
          else desired = null;
          return;
        }
        if (desired !== mode) {
          failures = 0;
          deliver();
          return;
        }
        const retryInMs = delays[Math.min(failures, delays.length - 1)]!;
        failures += 1;
        options.logger.warn("computer browser did not take the egress mode; retrying", { mode, retryInMs, error: error instanceof Error ? error.message : String(error) });
        backoff = { mode, timer: setTimer(deliver, retryInMs) };
      },
    );
  };

  return {
    apply(mode) {
      desired = mode;
      if (backoff && backoff.mode !== mode) {
        clearTimer(backoff.timer);
        failures = 0;
        deliver();
        return;
      }
      if (!busy) deliver();
    },
  };
}

const CONTROL_TIMEOUT_MS = 10_000;

export function controlApiModePoster(controlUrl: string, fetchImpl: typeof fetch = fetch): (mode: GatewayEgressMode) => Promise<void> {
  return async (mode) => {
    const response = await fetchImpl(`${controlUrl}/egress`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-octogee-egress-control": "1" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
    });
    if (response.ok) return;
    const detail = `desktop control answered ${response.status}: ${(await response.text()).slice(0, 200)}`;
    throw response.status === 404 ? new BrowserModeUnsupportedError(detail) : new Error(detail);
  };
}
