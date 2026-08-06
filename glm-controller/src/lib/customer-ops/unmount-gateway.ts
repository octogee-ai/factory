export type UnmountOutcome = "unmounted" | "skipped-no-live-pod";

export interface GatewayUnmountTarget {
  gatewayId: string;
  revisionId: string;
  profile: "standard" | "operator";
}

export interface UnmountFromGatewayDeps {
  resolveGatewayUnmountTarget: (gatewayId: string) => Promise<GatewayUnmountTarget | null>;

  readAvailableReplicas: (revisionId: string) => Promise<number | null>;

  unmountRpc: (opts: { gatewayId: string; revisionId: string; slug: string }) => Promise<void>;

  wait: (ms: number) => Promise<void>;
  now: () => number;
  retryDeadlineMs?: number;
  retryIntervalMs?: number;
  log: (msg: string) => void;
}

const DEFAULT_RETRY_DEADLINE_MS = 90_000;
const DEFAULT_RETRY_INTERVAL_MS = 5_000;

// undici surfaces connection-level failures (refused/reset/DNS) as exactly
// TypeError("fetch failed"); any other TypeError is a programming error and
// must not be retried. HTTP and timeout failures mean the server was reached
// and stay loud.
function isConnectionFailure(err: unknown): err is TypeError {
  return err instanceof TypeError && err.message === "fetch failed";
}

function causeCode(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? "";
}

function describeFailure(err: TypeError): string {
  const cause = causeCode(err);
  return cause ? `${err.message} (${cause})` : err.message;
}

// A pod with zero available replicas has no local customer footprint (emptyDir),
// and the gateway's level-triggered mount reconcile only mounts slugs still
// assigned in Firestore — which deprovision deletes — so a future boot cannot
// resurrect the customer. Skipping is the truthful outcome, not a swallowed error.
export function createUnmountFromGateway(
  deps: UnmountFromGatewayDeps,
): (gatewayId: string, slug: string) => Promise<UnmountOutcome> {
  const retryDeadlineMs = deps.retryDeadlineMs ?? DEFAULT_RETRY_DEADLINE_MS;
  const retryIntervalMs = deps.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  return async (gatewayId, slug) => {
    const target = await deps.resolveGatewayUnmountTarget(gatewayId);
    if (!target || target.gatewayId !== gatewayId) {
      throw new Error(`gateway ${gatewayId} has no validated serving revision`);
    }

    const deadline = deps.now() + retryDeadlineMs;
    let attempts = 0;
    for (;;) {
      const available = await deps.readAvailableReplicas(target.revisionId);
      if (available == null || available < 1) {
        deps.log(
          `[deprovision] unmount skipped for ${slug}: gateway ${gatewayId} revision ${target.revisionId} has no live pod (availableReplicas=${available ?? "deployment-missing"})`,
        );
        return "skipped-no-live-pod";
      }

      attempts += 1;
      try {
        await deps.unmountRpc({ gatewayId, revisionId: target.revisionId, slug });
        return "unmounted";
      } catch (err) {
        if (!isConnectionFailure(err)) throw err;
        if (deps.now() + retryIntervalMs > deadline) {
          throw new Error(
            `unmount unreachable after ${attempts} attempts over ${retryDeadlineMs}ms gatewayId=${gatewayId} revisionId=${target.revisionId} slug=${slug}: ${describeFailure(err)}`,
          );
        }
        deps.log(
          `[deprovision] unmount attempt ${attempts} unreachable for ${slug} on ${gatewayId}/${target.revisionId}: ${describeFailure(err)} — retrying in ${retryIntervalMs}ms`,
        );
        await deps.wait(retryIntervalMs);
      }
    }
  };
}
