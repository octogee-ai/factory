import type { BuilderSecret, SecretsRepository } from "./platform-state/secrets.js";

export interface ConnectorRevocationTarget {
  connectorId: string;
  revocationUrl: string;
}

export interface ConnectorRevocationDeps {
  secrets: Pick<SecretsRepository, "get">;
  decryptSecret: (ciphertext: string) => Promise<string>;
  logger: { warn: (message: string) => void };
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function revocableCiphertext(grant: BuilderSecret | null): string | null {
  if (!grant) return null;
  if (grant.kind !== "connector") throw new Error(`secret ${grant.secretId} is not a connector grant`);
  return grant.encryptedRefreshToken || grant.encryptedAccessToken || null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function revokeProviderGrant(
  uid: string,
  target: ConnectorRevocationTarget,
  deps: ConnectorRevocationDeps,
): Promise<void> {
  try {
    const ciphertext = revocableCiphertext(await deps.secrets.get(uid, target.connectorId));
    if (ciphertext === null) return;

    const response = await (deps.fetchImpl ?? fetch)(target.revocationUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: await deps.decryptSecret(ciphertext) }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      deps.logger.warn(
        `[connect] ${target.connectorId} provider revoke returned ${response.status} for uid=${uid}`,
      );
    }
  } catch (error) {
    deps.logger.warn(
      `[connect] ${target.connectorId} provider revoke failed for uid=${uid}: ${errorMessage(error)}`,
    );
  }
}

export async function revokeAllConnectorGrantsForUser(
  uid: string,
  targets: readonly ConnectorRevocationTarget[],
  deps: ConnectorRevocationDeps,
): Promise<void> {
  for (const target of targets) {
    await revokeProviderGrant(uid, target, deps);
  }
}
