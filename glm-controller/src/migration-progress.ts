import type { MigrationProgressRequestBody } from "@octogee/shared/types/fleet-controller";

type ProgressEvent = Pick<MigrationProgressRequestBody, "phase" | "status" | "elapsedMs">;

export function createMigrationProgress(deps: {
  send: (event: ProgressEvent) => Promise<unknown>;
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let forwarding = true;
  const started = new Map<string, number>();
  const report = async (phase: string, status: ProgressEvent["status"]): Promise<void> => {
    if (status === "running") started.set(phase, now());
    const start = started.get(phase);
    const event = { phase, status, ...(start === undefined ? {} : { elapsedMs: Math.max(0, now() - start) }) };
    if (forwarding) {
      try {
        await deps.send(event);
        return;
      } catch (error) {
        forwarding = false;
        deps.log(`🔴 [migration] destination progress unavailable: ${String(error)}; continuing progress in Cowboy logs`);
      }
    }
    const icons = { done: "🟢", failed: "🔴", pending: "🟡", running: "🟡", skipped: "🟡" };
    const icon = icons[status];
    deps.log(`${icon} [migration] ${JSON.stringify(event)}`);
  };
  return {
    report,
    async run<T>(phase: string, action: () => Promise<T>): Promise<T> {
      await report(phase, "running");
      let result: T;
      try {
        result = await action();
      } catch (error) {
        await report(phase, "failed");
        throw error;
      }
      await report(phase, "done");
      return result;
    },
  };
}
