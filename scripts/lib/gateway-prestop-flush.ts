export interface GatewayPreStopFlushDeps {
  gatewayId: string;
  gatewayClass: string;
  syncWorkspaces: () => Promise<void>;
  syncBlobs?: () => Promise<void>;
  syncSystemConfig?: () => Promise<void | { acceptedCommit: string }>;
  releaseGiteaKey?: () => Promise<void>;
  log: (msg: string) => void;
  now?: () => number;
}

export interface GatewayPreStopFlushStep {
  name: "workspace-git" | "blob-sync" | "system-config" | "gitea-key-release";
  status: "done" | "failed" | "skipped";
  error?: string;
  durationMs: number;
}

export interface GatewayPreStopFlushResult {
  ok: boolean;
  durationMs: number;
  systemConfigCommit?: string;
  steps: GatewayPreStopFlushStep[];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runStep<T>(
  deps: Pick<GatewayPreStopFlushDeps, "log" | "now">,
  name: GatewayPreStopFlushStep["name"],
  fn: (() => Promise<T>) | undefined,
): Promise<{ step: GatewayPreStopFlushStep; value?: T }> {
  const now = deps.now ?? Date.now;
  const started = now();
  if (!fn) {
    return { step: { name, status: "skipped", durationMs: 0 } };
  }
  try {
    const value = await fn();
    const durationMs = now() - started;
    deps.log(`[prestop-flush] ${name} done in ${durationMs}ms`);
    return { step: { name, status: "done", durationMs }, value };
  } catch (err) {
    const durationMs = now() - started;
    const error = errorMessage(err);
    deps.log(`[prestop-flush] ${name} failed in ${durationMs}ms: ${error}`);
    return { step: { name, status: "failed", error, durationMs } };
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

  const workspace = await runStep(deps, "workspace-git", deps.syncWorkspaces);
  const blobs = await runStep(deps, "blob-sync", deps.syncBlobs);
  const systemConfig = await runStep(deps, "system-config", deps.syncSystemConfig);
  const durableSteps = [workspace.step, blobs.step, systemConfig.step];
  const durableFlushSucceeded = durableSteps.every((step) => step.status !== "failed");
  const keyRelease = await runStep(
    deps,
    "gitea-key-release",
    durableFlushSucceeded ? deps.releaseGiteaKey : undefined,
  );
  const steps = [...durableSteps, keyRelease.step];
  const durationMs = now() - started;
  const ok = steps.every((step) => step.status !== "failed");
  deps.log(`[prestop-flush] complete ok=${ok} durationMs=${durationMs}`);
  const systemConfigCommit = systemConfig.value &&
    typeof systemConfig.value === "object" &&
    "acceptedCommit" in systemConfig.value &&
    typeof systemConfig.value.acceptedCommit === "string"
    ? systemConfig.value.acceptedCommit
    : undefined;
  return {
    ok,
    durationMs,
    steps,
    ...(systemConfigCommit ? { systemConfigCommit } : {}),
  };
}
