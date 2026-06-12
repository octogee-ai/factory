

export interface ResolveGcpProjectOpts {
  
  gcpProject?: string;
  
  platformDefault: string;
}

export function resolveDefaultStorageBucket(gcpProject: string | undefined): string {
  const project = gcpProject?.trim();
  if (!project) {
    throw new Error(
      "resolveDefaultStorageBucket: GOOGLE_CLOUD_PROJECT is not set — refusing to guess " +
        "the avatar bucket (a cross-project default would delete from the wrong bucket).",
    );
  }
  return `${project}.firebasestorage.app`;
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
