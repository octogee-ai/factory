import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { deploymentTargetForFirebaseProject } from "./deployment-environment.js";

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

export function secretReplicationPolicy(targetProjectId: string) {
  const target = deploymentTargetForFirebaseProject(targetProjectId);
  return { userManaged: { replicas: [{ location: target.region }] } };
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
        replication: secretReplicationPolicy(projectId()),
        labels: params.labels,
      },
    });
  } catch (err) {
    if ((err as { code?: number } | null)?.code !== 6) throw err;
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

export async function addSecretVersionIfExists(
  name: string,
  value: string,
): Promise<
  { ok: true; versionName: string } | { ok: false; reason: "not_found" }
> {
  const secretName = fqSecretName(name);
  try {
    const [version] = await client().addSecretVersion({
      parent: secretName,
      payload: { data: Buffer.from(value, "utf8") },
    });
    if (!version.name) {
      throw new Error("Secret Manager returned an unnamed version");
    }
    return { ok: true, versionName: version.name };
  } catch (err) {
    if ((err as { code?: number } | null)?.code === 5) {
      return { ok: false, reason: "not_found" };
    }
    throw err;
  }
}

export type SubscriptionSecretVersionResult =
  | { ok: true; changed: false; destroyed: number }
  | { ok: true; changed: true; versionName: string; destroyed: number }
  | { ok: false; reason: "not_found" };

function secretVersionNumber(versionName: string): number {
  const match = /\/versions\/(\d+)$/.exec(versionName);
  return match ? Number(match[1]) : Number.NaN;
}

// Two gateway pods can sync the same credential during a surge, so the survivor
// is chosen from the live list after the add, never assumed to be this call's
// version: whichever version is numerically newest stays, everything else goes.
async function destroySupersededSecretVersions(secretName: string): Promise<number> {
  const [versions] = await client().listSecretVersions({ parent: secretName });
  const live = versions.filter(
    (candidate): candidate is typeof candidate & { name: string } =>
      typeof candidate.name === "string" && candidate.state !== "DESTROYED",
  );
  const newest = live.reduce<string | null>(
    (best, candidate) =>
      best === null || secretVersionNumber(candidate.name) > secretVersionNumber(best)
        ? candidate.name
        : best,
    null,
  );
  let destroyed = 0;
  for (const superseded of live) {
    if (superseded.name === newest) continue;
    await client().destroySecretVersion({ name: superseded.name });
    destroyed++;
  }
  return destroyed;
}

// Subscription credentials rotate on every refresh and only the newest copy can
// ever be restored, so every superseded version is destroyed rather than left
// billing as a live version. Callers that pin versions (byok api keys) must not
// use this.
export async function addSecretVersionKeepingLatest(
  name: string,
  value: string,
): Promise<SubscriptionSecretVersionResult> {
  const secretName = fqSecretName(name);
  let latest: string | null = null;
  try {
    const [current] = await client().accessSecretVersion({ name: `${secretName}/versions/latest` });
    latest = current.payload?.data ? Buffer.from(current.payload.data).toString("utf8") : null;
  } catch (err) {
    const code = (err as { code?: number } | null)?.code;
    if (code === 5) return { ok: false, reason: "not_found" };
    if (code !== 9) throw err;
  }
  if (latest === value) {
    return { ok: true, changed: false, destroyed: await destroySupersededSecretVersions(secretName) };
  }

  const [version] = await client().addSecretVersion({
    parent: secretName,
    payload: { data: Buffer.from(value, "utf8") },
  });
  if (!version.name) {
    throw new Error("Secret Manager returned an unnamed version");
  }
  return {
    ok: true,
    changed: true,
    versionName: version.name,
    destroyed: await destroySupersededSecretVersions(secretName),
  };
}

export async function readSecret(
  name: string,
  version = "latest",
): Promise<string> {
  const [v] = await client().accessSecretVersion({
    name: `${fqSecretName(name)}/versions/${version}`,
  });
  const data = v.payload?.data;
  if (!data) throw new Error(`Secret ${name} has no payload`);
  return Buffer.from(data as Uint8Array).toString("utf8");
}

export async function readSecretWithLabels(
  name: string,
  version = "latest",
): Promise<{ value: string; labels: Record<string, string> }> {
  const secretName = fqSecretName(name);
  const [secret] = await client().getSecret({ name: secretName });
  const [v] = await client().accessSecretVersion({
    name: `${secretName}/versions/${version}`,
  });
  const data = v.payload?.data;
  if (!data) throw new Error(`Secret ${name} has no payload`);
  return {
    value: Buffer.from(data as Uint8Array).toString("utf8"),
    labels: secret.labels ?? {},
  };
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
  } catch (err) {
    if ((err as { code?: number } | null)?.code === 5) {
      return { disabledCount: 0 };
    }
    throw err;
  }
}

// Hard-delete the whole secret (container + all versions + its IAM bindings).
// For decommission teardown a dead gateway's token must not linger as a
// standing credential — archive (disable versions) leaves the container and
// its resource-IAM, so retirement deletes. Idempotent: a NotFound (code 5)
// is success, never an error.
export async function deleteSecret(name: string): Promise<{ deleted: boolean }> {
  try {
    await client().deleteSecret({ name: fqSecretName(name) });
    return { deleted: true };
  } catch (err) {
    if ((err as { code?: number } | null)?.code === 5) {
      return { deleted: false };
    }
    throw err;
  }
}

const GATEWAY_AUTH_TOKEN_SECRET_ROLES = [
  "roles/secretmanager.secretAccessor",
  "roles/secretmanager.secretVersionAdder",
  "roles/secretmanager.secretVersionManager",
];

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
      secret: { replication: secretReplicationPolicy(projectId()) },
    });
  } catch (err: unknown) {
    if ((err as { code?: number })?.code !== 6) throw err;
    created = false;
  }

  const member = `serviceAccount:${params.gatewayServiceAccount}`;
  const [policy] = await client().getIamPolicy({ resource: secretName });
  type IamBinding = { role?: string | null; members?: string[] | null };
  const bindings: IamBinding[] = policy.bindings ?? [];
  let mutated = false;
  for (const role of GATEWAY_AUTH_TOKEN_SECRET_ROLES) {
    let binding = bindings.find((b: IamBinding) => b.role === role);
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
