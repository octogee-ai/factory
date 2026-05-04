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
    if (err?.code !== 6) throw err;
  }

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
    if (err?.code === 5) return { disabledCount: 0 };
    throw err;
  }
}

const GATEWAY_AUTH_TOKEN_SECRET_ROLES = [
  "roles/secretmanager.secretAccessor",
  "roles/secretmanager.secretVersionAdder",
  "roles/secretmanager.secretVersionManager",
];

/**
 * Provisions the per-gateway auth-token Secret Manager secret +
 * IAM grants required for a new gateway pod to publish its token.
 * Idempotent: re-creating an existing secret is a no-op; re-applying
 * the same IAM bindings doesn't fail.
 *
 * `gatewayId` matches the suffix used by entrypoint.sh in the gateway
 * pod (`gateway-auth-token-${GATEWAY_ID}`). The gateway GSA needs all
 * three roles: read its own token (accessor), publish a new version
 * (versionAdder), and manage version state on rotation
 * (versionManager).
 */
export async function provisionGatewayAuthSecret(params: {
  gatewayId: string;
  gatewayServiceAccount: string;
}): Promise<{ secretName: string; created: boolean }> {
  const secretId = `gateway-auth-token-${params.gatewayId}`;
  const parent = `projects/${projectId()}`;
  const secretName = fqSecretName(secretId);

  let created = true;
  try {
    await client().createSecret({
      parent,
      secretId,
      secret: { replication: { automatic: {} } },
    });
  } catch (err: unknown) {
    if ((err as { code?: number })?.code !== 6) throw err;
    created = false;
  }

  const member = `serviceAccount:${params.gatewayServiceAccount}`;
  const [policy] = await client().getIamPolicy({ resource: secretName });
  const bindings = policy.bindings ?? [];
  let mutated = false;
  for (const role of GATEWAY_AUTH_TOKEN_SECRET_ROLES) {
    let binding = bindings.find((b) => b.role === role);
    if (!binding) {
      binding = { role, members: [] };
      bindings.push(binding);
      mutated = true;
    }
    if (!binding.members?.includes(member)) {
      binding.members = [...(binding.members ?? []), member];
      mutated = true;
    }
  }
  if (mutated) {
    await client().setIamPolicy({
      resource: secretName,
      policy: { ...policy, bindings },
    });
  }

  return { secretName, created };
}

async function accessLatest(name: string): Promise<string | null> {
  try {
    const [response] = await client().accessSecretVersion({
      name: `${fqSecretName(name)}/versions/latest`,
    });
    const payload = response.payload?.data;
    if (!payload) return null;
    return Buffer.isBuffer(payload) ? payload.toString("utf8") : String(payload);
  } catch (err: any) {
    if (err?.code === 5) return null;
    throw err;
  }
}
