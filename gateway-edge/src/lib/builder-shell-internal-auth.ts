import * as crypto from "crypto";

export type BuilderShellInternalAuthMode = "platform" | "operator-gateway-token";

export interface BuilderShellInternalAuthSecret {
  value: string;
  mode: BuilderShellInternalAuthMode;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveBuilderShellInternalAuthSecret(
  env: Record<string, string | undefined> = process.env,
): BuilderShellInternalAuthSecret | null {
  const platformKey = nonBlank(env.INTERNAL_SERVICE_KEY);
  if (platformKey) return { value: platformKey, mode: "platform" };

  if (env.GATEWAY_PROFILE === "operator") {
    const gatewayToken = nonBlank(env.OPENCLAW_GATEWAY_TOKEN);
    if (gatewayToken) {
      return { value: gatewayToken, mode: "operator-gateway-token" };
    }
  }

  return null;
}

export function isValidBuilderShellInternalAuth(
  provided: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!provided) return false;
  const secret = resolveBuilderShellInternalAuthSecret(env);
  if (!secret) return false;
  try {
    return (
      provided.length === secret.value.length &&
      crypto.timingSafeEqual(
        Buffer.from(provided, "utf8"),
        Buffer.from(secret.value, "utf8"),
      )
    );
  } catch {
    return false;
  }
}
