export interface SecretWrite {
  name: string;
  value: string;
  labels?: Record<string, string>;
}

export type SecretVersionWriteResult =
  | { ok: true; versionName: string }
  | { ok: false; reason: "not_found" };

export type SubscriptionSecretVersionResult =
  | { ok: true; changed: false; destroyed: number }
  | { ok: true; changed: true; versionName: string; destroyed: number }
  | { ok: false; reason: "not_found" };

export interface SecretStore {
  writeSecret(input: SecretWrite): Promise<{ versionName: string }>;
  addSecretVersionIfExists(name: string, value: string): Promise<SecretVersionWriteResult>;
  addSecretVersionKeepingLatest(name: string, value: string): Promise<SubscriptionSecretVersionResult>;
  readSecret(name: string, version?: string): Promise<string>;
  readSecretWithLabels(name: string, version?: string): Promise<{ value: string; labels: Record<string, string> }>;
  archiveSecret(name: string): Promise<{ disabledCount: number }>;
  deleteSecret(name: string): Promise<{ deleted: boolean }>;
  provisionGatewayAuthSecret(input: {
    gatewayId: string;
    gatewayServiceAccount: string;
  }): Promise<{ secretName: string; created: boolean }>;
}

export class SecretNotFoundError extends Error {
  override readonly name = "SecretNotFoundError";
}

export function isSecretNotFound(error: unknown): boolean {
  return error instanceof SecretNotFoundError || (error as { code?: unknown } | null)?.code === 5;
}
