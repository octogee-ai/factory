// Resolves the GCP project a gateway-edge sidecar should run against.
// BYO-GCP seam: per-gateway `gcpProject` (from the glmGateways doc) wins;
// otherwise the platform default. Cowboy threads the result into the
// gateway-edge env as a `--set` so it's always present from the live
// desired-state — not a baked values file that can skew and drop it.

export interface ResolveGcpProjectOpts {
  /** Per-gateway project from the glmGateways desired-state (BYO-GCP). */
  gcpProject?: string;
  /** Platform fallback (the operator's own project — "octogee" today). */
  platformDefault: string;
}

export function resolveGatewayGcpProject(opts: ResolveGcpProjectOpts): string {
  const perGateway = opts.gcpProject?.trim();
  if (perGateway) return perGateway;
  const platform = opts.platformDefault?.trim();
  if (!platform) {
    throw new Error(
      "resolveGatewayGcpProject: no per-gateway gcpProject and no platform default — " +
        "refusing to render an empty GCP_PROJECT_ID (would silently break gateway-token resolution).",
    );
  }
  return platform;
}
