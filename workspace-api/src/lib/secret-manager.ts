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
