/**
 * Thin wrapper over @google-cloud/secret-manager for the BYOT flow.
 *
 * Authentication: uses Application Default Credentials (ADC). On GKE this
 * resolves to the pod's Workload Identity service account. Locally for
 * tests, mock the module.
 *
 * Naming: one secret per (customer, provider) pair —
 *   projects/{GCP_PROJECT}/secrets/byok-{slug}-{provider}
 * See scripts/lib/byot-auth-profiles.ts#secretNameFor for the grammar.
 *
 * One secret, many versions. `accessLatest()` always reads the live
 * version; rotation is just `addVersion()`. `archive()` disables all
 * versions (retains audit trail; we never hard-delete customer key
 * history).
 */
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const clientSingleton: { value: SecretManagerServiceClient | null } = { value: null };

function client(): SecretManagerServiceClient {
  if (!clientSingleton.value) {
    clientSingleton.value = new SecretManagerServiceClient();
  }
  return clientSingleton.value;
}

function projectId(): string {
  const p = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  if (!p) {
    throw new Error(
      "GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) must be set for Secret Manager access",
    );
  }
  return p;
}

function fqSecretName(name: string): string {
  return `projects/${projectId()}/secrets/${name}`;
}

/**
 * Create a secret if it doesn't exist, then add a new version with the
 * given payload. Returns the fully-qualified version name Secret Manager
 * assigned.
 *
 * Idempotent on create — a 6 ALREADY_EXISTS error on createSecret is
 * absorbed; we still add a new version.
 */
export async function writeSecret(params: {
  name: string;
  value: string;
  labels?: Record<string, string>;
}): Promise<{ versionName: string }> {
  const parent = `projects/${projectId()}`;
  const secretName = fqSecretName(params.name);

  try {
    await client().createSecret({
      parent,
      secretId: params.name,
      secret: {
        replication: { automatic: {} },
        labels: params.labels,
      },
    });
  } catch (err: any) {
    // code 6 = ALREADY_EXISTS. Any other error is real.
    if (err?.code !== 6) throw err;
  }

  // If labels changed (e.g. provider swapped), keep the secret's labels
  // in sync so `gcloud secrets list --filter="labels.slug=foo"` stays
  // accurate for operators.
  if (params.labels) {
    await client().updateSecret({
      secret: { name: secretName, labels: params.labels },
      updateMask: { paths: ["labels"] },
    });
  }

  const [version] = await client().addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(params.value, "utf8") },
  });

  if (!version.name) {
    throw new Error("Secret Manager returned an unnamed version");
  }
  return { versionName: version.name };
}

/**
 * Disable all enabled versions of a secret. Used when a customer removes
 * their BYOT key — we retain history for audit but the resolver can no
 * longer access any payload. Not destructive; operators can re-enable a
 * specific version via gcloud if needed.
 */
export async function archiveSecret(name: string): Promise<{ disabledCount: number }> {
  const secretName = fqSecretName(name);
  try {
    const [versions] = await client().listSecretVersions({ parent: secretName });
    let disabled = 0;
    for (const v of versions) {
      if (v.state === "ENABLED" && v.name) {
        await client().disableSecretVersion({ name: v.name });
        disabled++;
      }
    }
    return { disabledCount: disabled };
  } catch (err: any) {
    // 5 NOT_FOUND — idempotent: removing a key the customer never had is fine.
    if (err?.code === 5) return { disabledCount: 0 };
    throw err;
  }
}

/**
 * Read the latest enabled version of a secret. Intended for server-side
 * validation probes; OpenClaw's exec resolver has its own code path
 * (scripts/secret-resolver.mjs). Not used on the hot request path.
 */
export async function accessLatest(name: string): Promise<string | null> {
  try {
    const [response] = await client().accessSecretVersion({
      name: `${fqSecretName(name)}/versions/latest`,
    });
    const payload = response.payload?.data;
    if (!payload) return null;
    return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  } catch (err: any) {
    if (err?.code === 5) return null; // NOT_FOUND
    throw err;
  }
}
