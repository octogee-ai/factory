

export const REQUIRED_ENV = [
  "INTERNAL_SERVICE_KEY",
  "GCP_PROJECT_ID",
  "GITEA_TOKEN",
] as const;

export type RequiredEnvKey = (typeof REQUIRED_ENV)[number];

export interface ValidateRequiredEnvOpts {

isProd: boolean;

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
  if (opts.profile === "operator") return { missing: [] };
  const missing = REQUIRED_ENV.filter((key) => {
    const value = env[key];

return typeof value !== "string" || value.trim().length === 0;
  });
  return { missing: [...missing] };
}
