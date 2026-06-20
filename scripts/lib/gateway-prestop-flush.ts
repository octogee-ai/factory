export interface GatewayPreStopFlushDeps {
  gatewayId: string;
  gatewayClass: string;
  syncWorkspaces: () => Promise<void>;
  syncBlobs?: () => Promise<void>;
  syncSystemConfig?: () => Promise<void>;
  log: (msg: string) => void;
  now?: () => number;
}

export interface GatewayPreStopFlushStep {
  name: "workspace-git" | "blob-sync" | "system-config";
  status: "done" | "failed" | "skipped";
  error?: string;
  durationMs: number;
}

export interface GatewayPreStopFlushResult {
  ok: boolean;
  durationMs: number;
  steps: GatewayPreStopFlushStep[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runStep(
  deps: Pick<GatewayPreStopFlushDeps, "log" | "now">,
  name: GatewayPreStopFlushStep["name"],
  fn: (() => Promise<void>) | undefined,
): Promise<GatewayPreStopFlushStep> {
  const now = deps.now ?? Date.now;
  const started = now();
  if (!fn) {
    return { name, status: "skipped", durationMs: 0 };
  }
  try {
    await fn();
    const durationMs = now() - started;
    deps.log(`[prestop-flush] ${name} done in ${durationMs}ms`);
    return { name, status: "done", durationMs };
  } catch (err) {
    const durationMs = now() - started;
    const error = errorMessage(err);
    deps.log(`[prestop-flush] ${name} failed in ${durationMs}ms: ${error}`);
    return { name, status: "failed", error, durationMs };
  }
}

export async function runGatewayPreStopFlush(
  deps: GatewayPreStopFlushDeps,
): Promise<GatewayPreStopFlushResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  deps.log(
    `[prestop-flush] starting gateway=${deps.gatewayId} class=${deps.gatewayClass || "unknown"}`,
  );

  const steps = [
    await runStep(deps, "workspace-git", deps.syncWorkspaces),
    await runStep(deps, "blob-sync", deps.syncBlobs),
    await runStep(deps, "system-config", deps.syncSystemConfig),
  ];
  const durationMs = now() - started;
  const ok = steps.every((step) => step.status !== "failed");
  deps.log(`[prestop-flush] complete ok=${ok} durationMs=${durationMs}`);
  return { ok, durationMs, steps };
}
