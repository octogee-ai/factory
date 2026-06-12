export type UnmountOutcome = "unmounted" | "skipped-no-live-pod";

export interface UnmountFromGatewayDeps {
  readGatewayProfile: (gatewayId: string) => Promise<"standard" | "operator" | null>;

  readAvailableReplicas: (gatewayId: string) => Promise<number | null>;

  fleetSecret: string;

  readGatewayAuthToken: (gatewayId: string) => Promise<string>;

  unmountRpc: (opts: { gatewayId: string; slug: string; secret: string }) => Promise<void>;

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

async function resolveSecret(
  deps: UnmountFromGatewayDeps,
  profile: "standard" | "operator",
  gatewayId: string,
): Promise<string> {
  // Operator pods never mount FLEET_CONTROLLER_SECRET; their fleet server
  // verifies against the per-gateway OPENCLAW_GATEWAY_TOKEN instead.
  if (profile === "operator") return deps.readGatewayAuthToken(gatewayId);
  return deps.fleetSecret;
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
    const profile = await deps.readGatewayProfile(gatewayId);
    if (!profile) {
      throw new Error(`gateway not registered in glmGateways: ${gatewayId}`);
    }

    const deadline = deps.now() + retryDeadlineMs;
    let attempts = 0;
    let secret: string | null = null;
    for (;;) {
      const available = await deps.readAvailableReplicas(gatewayId);
      if (available == null || available < 1) {
        deps.log(
          `[deprovision] unmount skipped for ${slug}: gateway ${gatewayId} has no live pod (availableReplicas=${available ?? "deployment-missing"})`,
        );
        return "skipped-no-live-pod";
      }

      // Resolved after the replica gate so a sleeping gateway whose auth
      // secret is already gone still skips instead of failing.
      secret ??= await resolveSecret(deps, profile, gatewayId);

      attempts += 1;
      try {
        await deps.unmountRpc({ gatewayId, slug, secret });
        return "unmounted";
      } catch (err) {
        if (!isConnectionFailure(err)) throw err;
        if (deps.now() + retryIntervalMs > deadline) {
          throw new Error(
            `unmount unreachable after ${attempts} attempts over ${retryDeadlineMs}ms gatewayId=${gatewayId} slug=${slug}: ${describeFailure(err)}`,
          );
        }
        deps.log(
          `[deprovision] unmount attempt ${attempts} unreachable for ${slug} on ${gatewayId}: ${describeFailure(err)} — retrying in ${retryIntervalMs}ms`,
        );
        await deps.wait(retryIntervalMs);
      }
    }
  };
}
