import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { deploymentTargetSettings, type DeploymentEnvironmentSettings } from "@octogee/core/deployment-environment";
import { createPlatformContentMigrationPlan, parsePlatformContentMigrationArguments } from "../lib/platform-content-migration.js";

const CONTROL_BUCKET = "gs://octogee-terraform-state";
const SQL_TRANSFER_BUCKET = "gs://octogee-west-recovery";
const receiptPrefix = "receipts/platform-content-migration";
const POSTGRES_IMAGE = "postgres:16.14-alpine3.24@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
const KUBECTL = "kubectl";
const KUBE_CONTEXT_ARG = "--context";
const KUBE_NAMESPACE_ARG = "--namespace";

type Workload = { kind: "deployment" | "statefulset"; name: string; claim: string; serviceAccount: string; env: unknown[]; envFrom: unknown[] };
type Disk = { disk: string; zone: string; capacity: string };
type Metadata = { entries: number; bytes: number; digest: string };
type DatabaseMetadata = { tables: number; rows: number; digest: string; bootstrapViolations: number };
type CopyPodOptions = { settings: DeploymentEnvironmentSettings; target: Workload; sourceDisk: Disk; targetDisk: Disk; service: "mattermost" | "gitea"; migrationId: string; scratchDisk: string; image: string };
type CopyFilesOptions = { source: DeploymentEnvironmentSettings; target: DeploymentEnvironmentSettings; sourceDisk: Disk; targetDisk: Disk; targetWorkload: Workload; service: "mattermost" | "gitea"; migrationId: string; image: string };

function run(command: string, argumentsList: readonly string[], input?: string): string {
  const result = spawnSync(command, argumentsList, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? "signal"}): ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function json(command: string, argumentsList: readonly string[]): Record<string, unknown> {
  const value = JSON.parse(run(command, argumentsList));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command did not return a JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be non-empty`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function items(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function assertExactMergedMain(repoRoot: string): string {
  if (run("git", ["-C", repoRoot, "status", "--porcelain"])) throw new Error("platform content migration apply requires a clean working tree");
  run("git", ["-C", repoRoot, "fetch", "--quiet", "origin", "main"]);
  const head = run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
  if (head !== run("git", ["-C", repoRoot, "rev-parse", "refs/remotes/origin/main"])) throw new Error("platform content migration apply requires exact merged origin/main");
  return head;
}

function kube(settings: DeploymentEnvironmentSettings, argumentsList: readonly string[]): Record<string, unknown> {
  return json(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, ...argumentsList, "-o", "json"]);
}

export function discoverWorkload(value: unknown, service: "mattermost" | "gitea"): Workload {
  const candidates = items(record(value, "workload list").items, "workload list.items").flatMap((entry) => {
    const item = record(entry, "workload");
    const metadata = record(item.metadata, "workload.metadata");
    const spec = record(item.spec, "workload.spec");
    const pod = record(record(spec.template, "workload template").spec, "workload template spec");
    const name = text(metadata.name, "workload name");
    const claims = items(pod.volumes ?? [], "workload volumes").flatMap((volume) => {
      const claim = record(volume, "workload volume").persistentVolumeClaim;
      return claim ? [text(record(claim, "workload claim").claimName, "claim name")] : [];
    });
    if (!(service === "mattermost" ? /(^|-)mattermost($|-)/ : /(^|-)gitea($|-)/).test(name) || claims.length === 0) return [];
    const kind = text(item.kind, "workload kind").toLowerCase();
    if ((kind !== "deployment" && kind !== "statefulset") || claims.length !== 1) throw new Error(`${service} must have one Deployment or StatefulSet and exactly one PVC`);
    const container = record(items(pod.containers, "workload containers")[0], "workload container");
    return [{ kind, name, claim: claims[0]!, serviceAccount: typeof pod.serviceAccountName === "string" ? pod.serviceAccountName : "default", env: Array.isArray(container.env) ? container.env : [], envFrom: Array.isArray(container.envFrom) ? container.envFrom : [] } as Workload];
  });
  if (candidates.length !== 1) throw new Error(`expected exactly one ${service} workload with a PVC`);
  return candidates[0]!;
}

export function discoverDisk(pvc: unknown, pv: unknown): Disk {
  const pvcSpec = record(record(pvc, "pvc").spec, "pvc spec");
  const pvSpec = record(record(pv, "pv").spec, "pv spec");
  const csi = record(pvSpec.csi, "pv csi");
  if (text(csi.driver, "pv csi driver") !== "pd.csi.storage.gke.io") throw new Error("PVC must resolve to a GKE PD CSI disk");
  const match = /^projects\/[^/]+\/zones\/([^/]+)\/disks\/([^/]+)$/.exec(text(csi.volumeHandle, "pv csi volume handle"));
  if (!match) throw new Error("PVC must resolve to one zonal persistent disk");
  return { zone: match[1]!, disk: match[2]!, capacity: text(record(record(pvcSpec.resources, "pvc resources").requests, "pvc requests").storage, "pvc requested storage") };
}

function workload(settings: DeploymentEnvironmentSettings, service: "mattermost" | "gitea"): Workload {
  return discoverWorkload(kube(settings, ["get", "deployment,statefulset"]), service);
}

function disk(settings: DeploymentEnvironmentSettings, target: Workload): Disk {
  const pvc = kube(settings, ["get", "pvc", target.claim]);
  return discoverDisk(pvc, kube(settings, ["get", "pv", text(record(pvc.spec, "pvc spec").volumeName, "pvc volumeName")]));
}

function quiesce(settings: DeploymentEnvironmentSettings, target: Workload): void {
  run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "scale", `${target.kind}/${target.name}`, "--replicas=0"]);
  run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "rollout", "status", `${target.kind}/${target.name}`, "--timeout=10m"]);
  const current = kube(settings, ["get", target.kind, target.name]);
  const replicas = record(current.spec, "workload spec").replicas;
  const status = record(current.status ?? {}, "workload status");
  const active = status.replicas;
  const ready = status.readyReplicas;
  if (replicas !== 0 || (active !== undefined && active !== 0) || (ready !== undefined && ready !== 0)) throw new Error(`${target.name} is not quiesced`);
}

function requireImage(variable: string): string {
  const image = process.env[variable];
  if (!image || !/^us-west1-docker\.pkg\.dev\/octogee\/octogee\/octogee-gateway-operator:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`${variable} must be an approved immutable WEST operator image digest`);
  return image;
}

function passwordEnvironment(target: Workload, service: "mattermost" | "gitea"): unknown {
  const variable = service === "mattermost" ? "MM_DB_PASSWORD" : "GITEA__DATABASE__PASSWD";
  const matches = target.env.filter((value) => record(value, "workload environment").name === variable);
  if (matches.length !== 1) throw new Error(`${target.name} must expose exactly one ${variable} secret environment variable`);
  const environment = record(matches[0], "database password environment");
  const valueFrom = record(environment.valueFrom, "database password valueFrom");
  record(valueFrom.secretKeyRef, "database password secretKeyRef");
  return environment;
}

export function databaseProbeManifest(settings: DeploymentEnvironmentSettings, target: Workload, service: "mattermost" | "gitea", migrationId: string): Record<string, unknown> {
  const pod = name(migrationId, service, `dbmeta-${settings.region.includes("west") ? "west" : "central"}`);
  const user = service;
  const database = databaseName(settings.name, service);
  const credentialEnvironment = passwordEnvironment(target, service);
  const credentialVariable = text(record(credentialEnvironment, "database credential environment").name, "database credential environment name");
  const psql = `psql -h cloud-sql-proxy -U ${user} -d ${database}`;
  const bootstrapQuery = service === "mattermost"
    ? `SELECT ((SELECT count(*) FROM "Users" WHERE "DeleteAt" = 0 AND "Username" <> :'admin_username') + (SELECT count(*) FROM "Teams" WHERE "DeleteAt" = 0 AND "Name" <> 'octogee') + (SELECT count(*) FROM "Channels" AS c LEFT JOIN "Teams" AS t ON t."Id" = c."TeamId" WHERE c."DeleteAt" = 0 AND (COALESCE(t."Name", '') <> 'octogee' OR c."Name" NOT IN ('town-square', 'off-topic'))) + (SELECT count(*) FROM "Posts" AS p LEFT JOIN "Users" AS u ON u."Id" = p."UserId" WHERE p."DeleteAt" = 0 AND COALESCE(u."Username", '') NOT IN ('', :'admin_username')) + (SELECT count(*) FROM "FileInfo" WHERE "DeleteAt" = 0))::text`
    : `SELECT ((SELECT count(*) FROM "user" WHERE id > 0 AND lower_name NOT IN ('octogee-admin', 'octogee', 'ghost')) + (SELECT count(*) FROM repository) + (SELECT count(*) FROM issue) + (SELECT count(*) FROM comment))::text`;
  const bootstrapVariables = service === "mattermost" ? '-v admin_username="$MM_ADMIN_USER"' : "";
  const bootstrapCommand = [
    'if [ "$tables" = "0" ]; then',
    "bootstrap_violations=0",
    "else",
    `bootstrap_violations="$(${psql} ${bootstrapVariables} -At <<'OCTOGEE_BOOTSTRAP_SQL'`,
    bootstrapQuery,
    "OCTOGEE_BOOTSTRAP_SQL",
    ')"',
    "fi",
  ].join("\n");
  const command = [
    "set -eu",
    `export PGPASSWORD="\${${credentialVariable}:?}"`,
    `until pg_isready -h cloud-sql-proxy -U ${user} -d ${database}; do sleep 2; done`,
    `queries="$(${psql} -At -c "SELECT format('SELECT %L || E''\\\\t'' || count(*)::text FROM %I.%I;', schemaname || '.' || tablename, schemaname, tablename) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY schemaname, tablename")"`,
    `records="$(printf '%s\\n' "$queries" | ${psql} -At)"`,
    `schema="$(${psql} -At -F '\\t' -c "SELECT table_schema, table_name, column_name, ordinal_position, data_type, is_nullable FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name, ordinal_position")"`,
    "tables=\"$(printf '%s\\n' \"$records\" | sed '/^$/d' | wc -l | tr -d ' ')\"",
    "rows=\"$(printf '%s\\n' \"$records\" | awk -F '\\t' 'NF == 2 { s += $2 } END { print s + 0 }')\"",
    "digest=\"$(printf '%s\\n--schema--\\n%s\\n' \"$records\" \"$schema\" | sha256sum | awk '{print $1}')\"",
    bootstrapCommand,
    "printf '{\"tables\":%s,\"rows\":%s,\"digest\":\"%s\",\"bootstrapViolations\":%s}\\n' \"$tables\" \"$rows\" \"$digest\" \"$bootstrap_violations\"",
  ].join("\n");
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: pod, labels: { "app.kubernetes.io/managed-by": "platform-content-migration", "octogee.com/migration-id": migrationId } },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      securityContext: { seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "postgres",
        image: POSTGRES_IMAGE,
        command: ["sh", "-ceu", command],
        env: [
          credentialEnvironment,
          ...(service === "mattermost" ? [{ name: "MM_ADMIN_USER", valueFrom: { secretKeyRef: { name: "mattermost-gateway", key: "admin_user" } } }] : []),
        ],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
      }],
    },
  };
}

function databaseMetadata(settings: DeploymentEnvironmentSettings, target: Workload, service: "mattermost" | "gitea", migrationId: string): DatabaseMetadata {
  const pod = name(migrationId, service, `dbmeta-${settings.region.includes("west") ? "west" : "central"}`);
  apply(settings, databaseProbeManifest(settings, target, service, migrationId));
  try {
    run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "wait", `pod/${pod}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=10m"]);
    const value = record(JSON.parse(run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "logs", pod, "-c", "postgres"])), "database metadata");
    const metadata = { tables: Number(value.tables), rows: Number(value.rows), digest: text(value.digest, "database metadata digest"), bootstrapViolations: Number(value.bootstrapViolations) };
    if (!Number.isSafeInteger(metadata.tables) || !Number.isSafeInteger(metadata.rows) || !Number.isSafeInteger(metadata.bootstrapViolations) || metadata.bootstrapViolations < 0 || !/^[a-f0-9]{64}$/.test(metadata.digest)) throw new Error("database metadata verification failed");
    return metadata;
  } finally { remove(settings, "pod", pod); }
}

function name(migrationId: string, service: string, suffix: string): string {
  return `pcm-${migrationId}-${service}-${suffix}`.slice(0, 63);
}

function apply(settings: DeploymentEnvironmentSettings, manifest: unknown): void {
  run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "apply", "--server-side", "--field-manager=platform-content-migration", "-f", "-"], `${JSON.stringify(manifest)}\n`);
}

function remove(settings: DeploymentEnvironmentSettings, kind: string, resource: string): void {
  run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "delete", kind, resource, "--ignore-not-found=true", "--wait=true"]);
}

function targetPathAllowlist(service: "mattermost" | "gitea"): string {
  return service === "gitea"
    ? "! -path /target/lost+found ! -path '/target/lost+found/*' ! -path /target/gitea/conf ! -path '/target/gitea/conf/*' ! -path /target/gitea/sessions ! -path '/target/gitea/sessions/*' ! -path /target/gitea/log ! -path '/target/gitea/log/*' ! -path /target/gitea/tmp ! -path '/target/gitea/tmp/*' ! -path /target/git/.ssh ! -path '/target/git/.ssh/*' ! -path /target/ssh ! -path '/target/ssh/*'"
    : "! -path /target/lost+found ! -path '/target/lost+found/*'";
}

export function assertFreshTargetDatabase(metadata: DatabaseMetadata, service: "mattermost" | "gitea"): void {
  if (metadata.bootstrapViolations !== 0) {
    throw new Error(`target ${service} is not a fresh bootstrap database`);
  }
}

export function targetInventoryProbeManifest(
  settings: DeploymentEnvironmentSettings,
  target: Workload,
  service: "mattermost" | "gitea",
  migrationId: string,
  image: string,
): Record<string, unknown> {
  const pod = name(migrationId, service, "target-preflight");
  const command = [
    "set -eu",
    `unexpected="$(find /target -xdev -mindepth 1 ${targetPathAllowlist(service)} -print -quit)"`,
    "if [ -n \"$unexpected\" ]; then printf 'target PVC contains non-bootstrap data\\n' >&2; exit 42; fi",
    'printf \'{"unexpectedEntries":0}\\n\'',
  ].join("\n");
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: pod, labels: { "app.kubernetes.io/managed-by": "platform-content-migration", "octogee.com/migration-id": migrationId, "octogee.com/service": service } },
    spec: {
      automountServiceAccountToken: false,
      restartPolicy: "Never",
      securityContext: { seccompProfile: { type: "RuntimeDefault" } },
      containers: [{
        name: "preflight",
        image,
        command: ["sh", "-ceu", command],
        securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
        volumeMounts: [{ name: "target", mountPath: "/target", readOnly: true }],
      }],
      volumes: [{ name: "target", persistentVolumeClaim: { claimName: target.claim, readOnly: true } }],
    },
  };
}

function assertFreshTargetPvc(
  settings: DeploymentEnvironmentSettings,
  target: Workload,
  service: "mattermost" | "gitea",
  migrationId: string,
  image: string,
): { unexpectedEntries: 0 } {
  const pod = name(migrationId, service, "target-preflight");
  apply(settings, targetInventoryProbeManifest(settings, target, service, migrationId, image));
  try {
    run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "wait", `pod/${pod}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=10m"]);
    const output = record(JSON.parse(run(KUBECTL, [KUBE_CONTEXT_ARG, settings.kubeContext, KUBE_NAMESPACE_ARG, settings.namespace, "logs", pod, "-c", "preflight"])), "target PVC preflight");
    if (output.unexpectedEntries !== 0) throw new Error(`target ${service} PVC preflight did not prove bootstrap-only state`);
    return { unexpectedEntries: 0 };
  } finally {
    remove(settings, "pod", pod);
  }
}

export function copyPod({ settings, target, sourceDisk, targetDisk, service, migrationId, scratchDisk, image }: CopyPodOptions): Record<string, unknown> {
  const pv = name(migrationId, service, "pv");
  const claim = name(migrationId, service, "restore");
  const pod = name(migrationId, service, "copy");
  const labels = { "app.kubernetes.io/managed-by": "platform-content-migration", "octogee.com/migration-id": migrationId, "octogee.com/service": service };
  const excludes = service === "gitea"
    ? "--exclude=./lost+found --exclude=./gitea/conf --exclude=./gitea/sessions --exclude=./gitea/log --exclude=./gitea/tmp --exclude=./git/.ssh --exclude=./ssh"
    : "--exclude=./lost+found";
  const targetFindExclusions = targetPathAllowlist(service);
  const command = [
    "set -eu",
    `excludes='${excludes}'`,
    "metadata() { (cd \"$1\"; tar --sort=name --numeric-owner --acls --xattrs $excludes -cpf - .) | sha256sum | awk '{print $1}'; }",
    "entries() { (cd \"$1\"; tar --sort=name $excludes -cf - .) | tar -tf - | wc -l | tr -d ' '; }",
    "bytes() { (cd \"$1\"; tar --sort=name $excludes -cf - .) | wc -c | tr -d ' '; }",
    `find /target -xdev -depth -mindepth 1 ${targetFindExclusions} -delete`,
    `if find /target -xdev -mindepth 1 ${targetFindExclusions} -print -quit | grep -q .; then exit 41; fi`,
    "se=$(entries /source); sb=$(bytes /source); sd=$(metadata /source)",
    "tar --sort=name --numeric-owner --acls --xattrs $excludes -C /source -cpf - . | tar --numeric-owner --acls --xattrs -C /target -xpf -",
    "te=$(entries /target); tb=$(bytes /target); td=$(metadata /target)",
    "[ \"$se\" = \"$te\" ] && [ \"$sb\" = \"$tb\" ] && [ \"$sd\" = \"$td\" ]",
    "printf '{\"source\":{\"entries\":%s,\"bytes\":%s,\"digest\":\"%s\"},\"target\":{\"entries\":%s,\"bytes\":%s,\"digest\":\"%s\"}}\\n' \"$se\" \"$sb\" \"$sd\" \"$te\" \"$tb\" \"$td\"",
  ].join("\n");
  return { apiVersion: "v1", kind: "List", items: [
    { apiVersion: "v1", kind: "PersistentVolume", metadata: { name: pv, labels }, spec: { capacity: { storage: sourceDisk.capacity }, volumeMode: "Filesystem", accessModes: ["ReadOnlyMany"], persistentVolumeReclaimPolicy: "Retain", storageClassName: "", csi: { driver: "pd.csi.storage.gke.io", volumeHandle: `projects/${settings.clusterProjectId}/zones/${targetDisk.zone}/disks/${scratchDisk}`, fsType: "ext4", readOnly: true }, claimRef: { namespace: settings.namespace, name: claim } } },
    { apiVersion: "v1", kind: "PersistentVolumeClaim", metadata: { name: claim, labels }, spec: { accessModes: ["ReadOnlyMany"], storageClassName: "", volumeName: pv, resources: { requests: { storage: sourceDisk.capacity } } } },
    { apiVersion: "v1", kind: "Pod", metadata: { name: pod, labels }, spec: { automountServiceAccountToken: false, restartPolicy: "Never", securityContext: { seccompProfile: { type: "RuntimeDefault" } }, containers: [{ name: "copy", image, command: ["sh", "-ceu", command], securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } }, volumeMounts: [{ name: "source", mountPath: "/source", readOnly: true }, { name: "target", mountPath: "/target" }] }], volumes: [{ name: "source", persistentVolumeClaim: { claimName: claim, readOnly: true } }, { name: "target", persistentVolumeClaim: { claimName: target.claim } }] } },
  ] };
}

function copyFiles({ source, target, sourceDisk, targetDisk, targetWorkload, service, migrationId, image }: CopyFilesOptions): Metadata {
  const snapshot = name(migrationId, service, "snapshot");
  const scratch = name(migrationId, service, "disk");
  const pod = name(migrationId, service, "copy");
  let snapshotCreated = false;
  let scratchCreated = false;
  let primaryError: unknown;
  let copied: Metadata | undefined;
  try {
    run("gcloud", ["compute", "snapshots", "create", snapshot, "--project", source.clusterProjectId, "--source-disk", sourceDisk.disk, "--source-disk-zone", sourceDisk.zone, "--storage-location", target.region, "--labels", `managed-by=platform-content-migration,migration-id=${migrationId},service=${service}`]);
    snapshotCreated = true;
    const type = run("gcloud", ["compute", "disks", "describe", targetDisk.disk, "--project", target.clusterProjectId, "--zone", targetDisk.zone, "--format=value(type)"]);
    run("gcloud", ["compute", "disks", "create", scratch, "--project", target.clusterProjectId, "--zone", targetDisk.zone, "--source-snapshot", snapshot, "--type", type]);
    scratchCreated = true;
    apply(target, copyPod({ settings: target, target: targetWorkload, sourceDisk, targetDisk, service, migrationId, scratchDisk: scratch, image }));
    run(KUBECTL, [KUBE_CONTEXT_ARG, target.kubeContext, KUBE_NAMESPACE_ARG, target.namespace, "wait", `pod/${pod}`, "--for=jsonpath={.status.phase}=Succeeded", "--timeout=30m"]);
    const output = record(JSON.parse(run(KUBECTL, [KUBE_CONTEXT_ARG, target.kubeContext, KUBE_NAMESPACE_ARG, target.namespace, "logs", pod, "-c", "copy"])), "copy metadata");
    const parse = (value: unknown): Metadata => { const item = record(value, "copy metadata item"); return { entries: Number(item.entries), bytes: Number(item.bytes), digest: text(item.digest, "copy digest") }; };
    const from = parse(output.source); const to = parse(output.target);
    if (!Number.isSafeInteger(from.entries) || !Number.isSafeInteger(from.bytes) || !/^[a-f0-9]{64}$/.test(from.digest) || JSON.stringify(from) !== JSON.stringify(to)) throw new Error(`${service} file metadata verification failed`);
    copied = to;
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  const attempt = (operation: () => void) => {
    try { operation(); } catch (error) { cleanupErrors.push(error); }
  };
  attempt(() => remove(target, "pod", pod));
  attempt(() => remove(target, "pvc", name(migrationId, service, "restore")));
  attempt(() => remove(target, "pv", name(migrationId, service, "pv")));
  if (scratchCreated) attempt(() => run("gcloud", ["compute", "disks", "delete", scratch, "--project", target.clusterProjectId, "--zone", targetDisk.zone, "--quiet"]));
  if (snapshotCreated) attempt(() => run("gcloud", ["compute", "snapshots", "delete", snapshot, "--project", source.clusterProjectId, "--quiet"]));
  if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `${service} migration and cleanup failed`);
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${service} migration cleanup failed`);
  if (!copied) throw new Error(`${service} migration produced no verified copy metadata`);
  return copied;
}

function databaseName(environment: string, service: string): string { return `${service}_${environment === "test" ? "test" : "prod"}`; }

function assertDatabaseProxyReady(settings: DeploymentEnvironmentSettings): void {
  const endpoint = kube(settings, ["get", "endpoints", "cloud-sql-proxy"]);
  const subsets = items(endpoint.subsets ?? [], "cloud-sql-proxy endpoint subsets");
  const addresses = subsets.flatMap((value) => items(record(value, "cloud-sql-proxy endpoint subset").addresses ?? [], "cloud-sql-proxy endpoint addresses"));
  if (addresses.length === 0) throw new Error(`${settings.targetId} cloud-sql-proxy has no ready endpoint`);
}

function resetTargetDatabase(target: DeploymentEnvironmentSettings, service: "mattermost" | "gitea"): void {
  const database = databaseName(target.name, service);
  run("gcloud", ["sql", "databases", "delete", database, "--instance", target.cloudSqlInstanceName, "--project", target.cloudSqlProjectId, "--quiet"]);
  run("gcloud", ["sql", "databases", "create", database, "--instance", target.cloudSqlInstanceName, "--project", target.cloudSqlProjectId]);
}

function migrateDatabase(source: DeploymentEnvironmentSettings, target: DeploymentEnvironmentSettings, service: "mattermost" | "gitea", migrationId: string): void {
  const uri = `${SQL_TRANSFER_BUCKET}/platform-content-migration/${migrationId}/sql/${service}.sql.gz`;
  const database = databaseName(source.name, service);
  let exported = false;
  try {
    run("gcloud", ["sql", "export", "sql", source.cloudSqlInstanceName, uri, "--project", source.cloudSqlProjectId, "--database", database, "--offload"]);
    exported = true;
    run("gcloud", ["sql", "import", "sql", target.cloudSqlInstanceName, uri, "--project", target.cloudSqlProjectId, "--database", database, `--user=${service}`]);
  } finally {
    if (exported) run("gcloud", ["storage", "rm", uri]);
  }
}

function receiptUri(source: string, target: string, migrationId: string): string { return `${CONTROL_BUCKET}/${receiptPrefix}/${source}-to-${target}/${migrationId}.json`; }

function receiptExists(uri: string): boolean {
  try {
    run("gcloud", ["storage", "ls", uri]);
    return true;
  } catch (error) {
    if (error instanceof Error && /matched no objects|not found/i.test(error.message)) return false;
    throw error;
  }
}

function main(): void {
  const plan = createPlatformContentMigrationPlan(parsePlatformContentMigrationArguments(process.argv.slice(2)));
  const receipt = receiptUri(plan.source, plan.target, plan.migrationId);
  if (plan.dryRun) { process.stdout.write(`${JSON.stringify({ ...plan, receipt, safety: ["Cloud SQL database-only export/import; no role/password copy", "discovered workload PVCs and PD CSI disks", "snapshot restore copied inside one target pod", "content-bearing archive digest verification", "source and target Mattermost/Gitea quiesced before any transfer"] }, null, 2)}\n`); return; }
  const revision = assertExactMergedMain(fileURLToPath(new URL("../..", import.meta.url)));
  if (receiptExists(receipt)) throw new Error("migration receipt already exists; completed migrations cannot be replayed");
  const source = deploymentTargetSettings(plan.source); const target = deploymentTargetSettings(plan.target);
  if (!source.region.includes("central") || !target.region.includes("west") || source.name !== target.name) throw new Error("target pair is not an exact same-environment central-to-west migration");
  const image = requireImage("PLATFORM_CONTENT_MIGRATION_COPY_IMAGE");
  const states = (["mattermost", "gitea"] as const).map((service) => { const sourceWorkload = workload(source, service); const targetWorkload = workload(target, service); return { service, sourceWorkload, targetWorkload, sourceDisk: disk(source, sourceWorkload), targetDisk: disk(target, targetWorkload) }; });
  for (const state of states) quiesce(target, state.targetWorkload);
  assertDatabaseProxyReady(source);
  assertDatabaseProxyReady(target);
  const targetPreflight = states.map((state) => {
    const database = databaseMetadata(target, state.targetWorkload, state.service, plan.migrationId);
    assertFreshTargetDatabase(database, state.service);
    return { service: state.service, database, pvc: assertFreshTargetPvc(target, state.targetWorkload, state.service, plan.migrationId, image) };
  });
  for (const state of states) quiesce(source, state.sourceWorkload);
  const databaseBefore = states.map((state) => ({ service: state.service, source: databaseMetadata(source, state.sourceWorkload, state.service, plan.migrationId), target: targetPreflight.find((value) => value.service === state.service)!.database }));
  for (const state of states) resetTargetDatabase(target, state.service);
  const transferred = states.map((state) => ({ service: state.service, files: copyFiles({ source, target, sourceDisk: state.sourceDisk, targetDisk: state.targetDisk, targetWorkload: state.targetWorkload, service: state.service, migrationId: plan.migrationId, image }), database: databaseName(source.name, state.service) }));
  for (const state of states) migrateDatabase(source, target, state.service, plan.migrationId);
  const databaseAfter = states.map((state) => ({ service: state.service, target: databaseMetadata(target, state.targetWorkload, state.service, plan.migrationId) }));
  for (const state of databaseBefore) { const after = databaseAfter.find((value) => value.service === state.service)!; if (JSON.stringify(state.source) !== JSON.stringify(after.target)) throw new Error(`${state.service} database metadata differs after import`); }
  run("gcloud", ["storage", "cp", "-", receipt], `${JSON.stringify({ schemaVersion: 1, migrationId: plan.migrationId, source: plan.source, target: plan.target, revision, completedAt: new Date().toISOString(), transfer: plan.transfer, targetCredentials: "preserved-platform-generated", targetPreflight, services: transferred })}\n`);
  process.stdout.write(`${JSON.stringify({ migrationId: plan.migrationId, receipt, status: "complete", workloads: "left-quiesced-for-explicit-cutover" })}\n`);
}

function isEntrypoint(moduleUrl: string, entrypoint: string | undefined): boolean {
  if (!entrypoint) return false;
  try { return fs.realpathSync(fileURLToPath(moduleUrl)) === fs.realpathSync(entrypoint); }
  catch { return fileURLToPath(moduleUrl) === entrypoint; }
}

if (isEntrypoint(import.meta.url, process.argv[1])) main();
