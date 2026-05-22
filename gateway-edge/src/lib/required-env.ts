// Boot-time required-env contract for gateway-edge. Centralizes the env
// vars the process cannot function without so a missing one fails LOUD at
// startup instead of limping into runtime failures (activity bridge "no
// token source", git 401, builder-shell denies).
//
// Background: the gateway-edge env is supplied via the chart's
// `.Values.gatewayEdge.env` / `.secrets` ranges, threaded per-gateway by
// Cowboy. A version-skewed render or a dropped-on-apply duplicate can
// leave a required var unset with no boot-time signal. This guard is the
// fail-loud backstop.

// Only vars gateway-edge actually READS at runtime. GITEA_ORG is
// intentionally absent — the Gitea client takes `org` as an explicit
// per-call argument (no shared-org env fallback), so requiring it here
// would crash-loop a gateway for a var nothing consumes.
export const REQUIRED_ENV = [
  "INTERNAL_SERVICE_KEY",
  "GCP_PROJECT_ID",
  "GITEA_TOKEN",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV)[number];

export interface ValidateRequiredEnvOpts {
  /** Only enforce in prod-like environments — dev/test/local legitimately
   *  run without these (mocked Firestore, no Gitea, etc.). */
  isProd: boolean;
  /** Capability profile (cattle vs operator). Reserved for profile-specific
   *  requirements (e.g. BYO-GCP operator gateways); the core set is shared. */
  profile?: string;
}

export interface RequiredEnvResult {
  missing: string[];
}

export function validateRequiredEnv(
  env: Record<string, string | undefined>,
  opts: ValidateRequiredEnvOpts,
): RequiredEnvResult {
  if (!opts.isProd) return { missing: [] };
  const missing = REQUIRED_ENV.filter((key) => {
    const value = env[key];
    // Trim before length-check: a whitespace-only credential/ID is
    // effectively missing and would fail the same way at runtime.
    return typeof value !== "string" || value.trim().length === 0;
  });
  return { missing: [...missing] };
}
