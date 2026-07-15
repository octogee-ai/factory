import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
const clientSingleton = { value: null };
function client() {
    if (!clientSingleton.value) {
        clientSingleton.value = new SecretManagerServiceClient();
    }
    return clientSingleton.value;
}
function projectId() {
    const p = process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
    if (!p) {
        throw new Error("GCP_PROJECT_ID (or GOOGLE_CLOUD_PROJECT) must be set for Secret Manager access");
    }
    return p;
}
function fqSecretName(name) {
    return `projects/${projectId()}/secrets/${name}`;
}
// Single-region (us-central1) replication. The platform lives entirely in
// us-central1, so multi-region "automatic" replication adds no real
// availability (region down ⇒ cluster down too) and costs ~25× the
// per-version storage. All programmatic secret creation must use this. See
// DECISIONS.md.
export const SINGLE_REGION_REPLICATION = {
    userManaged: { replicas: [{ location: "us-central1" }] },
};
export async function writeSecret(params) {
    const parent = `projects/${projectId()}`;
    const secretName = fqSecretName(params.name);
    try {
        await client().createSecret({
            parent,
            secretId: params.name,
            secret: {
                replication: SINGLE_REGION_REPLICATION,
                labels: params.labels,
            },
        });
    }
    catch (err) {
        if (err?.code !== 6)
            throw err;
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
export async function addSecretVersionIfExists(name, value) {
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
    }
    catch (err) {
        if (err?.code === 5) {
            return { ok: false, reason: "not_found" };
        }
        throw err;
    }
}
export async function readSecret(name, version = "latest") {
    const [v] = await client().accessSecretVersion({
        name: `${fqSecretName(name)}/versions/${version}`,
    });
    const data = v.payload?.data;
    if (!data)
        throw new Error(`Secret ${name} has no payload`);
    return Buffer.from(data).toString("utf8");
}
export async function readSecretWithLabels(name, version = "latest") {
    const secretName = fqSecretName(name);
    const [secret] = await client().getSecret({ name: secretName });
    const [v] = await client().accessSecretVersion({
        name: `${secretName}/versions/${version}`,
    });
    const data = v.payload?.data;
    if (!data)
        throw new Error(`Secret ${name} has no payload`);
    return {
        value: Buffer.from(data).toString("utf8"),
        labels: secret.labels ?? {},
    };
}
export async function archiveSecret(name) {
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
    }
    catch (err) {
        if (err?.code === 5) {
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
export async function deleteSecret(name) {
    try {
        await client().deleteSecret({ name: fqSecretName(name) });
        return { deleted: true };
    }
    catch (err) {
        if (err?.code === 5) {
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
export async function provisionGatewayAuthSecret(params) {
    const secretId = `gateway-auth-token-${params.gatewayId}`;
    const parent = `projects/${projectId()}`;
    const secretName = fqSecretName(secretId);
    let created = true;
    try {
        await client().createSecret({
            parent,
            secretId,
            secret: { replication: SINGLE_REGION_REPLICATION },
        });
    }
    catch (err) {
        if (err?.code !== 6)
            throw err;
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
