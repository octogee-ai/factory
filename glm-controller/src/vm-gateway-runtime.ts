import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import type { SizingTier } from "@octogee/shared/types/sizing";
import {
  GLM_GATEWAYS_COLLECTION,
  gatewayVmRuntimeDocPath,
  isGatewayRuntime,
  resolveGatewayRuntime,
  type GatewayRuntime,
  type GatewayVmSpec,
  type GatewayVmState,
  type HelmInstancesMap,
} from "@octogee/shared/types/glm";
import type { GatewayVmClient } from "./lib/compute-vm.js";
import { createComputerLifecycle, recordVmObservation } from "./vm-computer-lifecycle.js";
import type { KubectlSubprocess } from "./fleet-ingress.js";
import {
  helmTemplateArgsFromUpgradeArgs,
  parseConcatenatedJson,
  renderVmRuntimeBundle,
} from "./lib/vm-runtime-bundle.js";
import { buildUpgradeArgs, type HelmRunner, type HelmSubprocess } from "./helm-runner.js";

const VM_ROUTES_CONFIGMAP_KEY = "routes.json";

export interface VmGatewayRuntime extends HelmRunner {
  readDeploymentPrerequisiteError(gatewayId: string): Promise<string | null>;
  recoverUnreachable(gatewayId: string): Promise<void>;
  deleteComputer(ownerUid: string): Promise<boolean>;
  detectPreemption(gatewayId: string, sinceMs: number): Promise<string | null>;
}

export interface VmGatewayRuntimeDeps {
  db: Firestore;
  namespace: string;
  environment: string;
  runHelm: HelmSubprocess;
  runKubectl: KubectlSubprocess;
  vm: GatewayVmClient;
  vmSpec: GatewayVmSpec;
  computeProjectId: string;
  bridgeServiceName: string;
  hostAliasNames: readonly string[];
  kubernetes: { apiHost: string; apiPort: string; caCert: string };
  routesConfigMap: string;
  ensureAuthSecret?: (opts: { namespace: string; gatewayId: string }) => Promise<void>;
  readDesiredStatus: (gatewayId: string) => Promise<string | null>;
  upgradeTimeout?: string;
  wait: (ms: number) => Promise<void>;
  homeCheckpointTimeoutMs?: number;
  homeCheckpointPollMs?: number;
  now: () => number;
  log: (msg: string) => void;
}

export function resolveBuilderComputerPolicy(sizingTier: SizingTier | null | undefined) {
  const tier = sizingTier ?? "s";
  const computer = Object.values(BUILDER_TIERS).find((entry) => entry.instance === tier)?.computer;
  if (!computer) throw new Error(`No Builder computer policy for sizing tier ${tier}`);
  return computer;
}

function assertZones(zones: unknown): void {
  if (!Array.isArray(zones) || zones.length === 0 || zones.some((zone) => typeof zone !== "string" || zone.length === 0)) {
    throw new Error("GATEWAY_VM_SPEC_JSON.zones must be a non-empty array of zone names");
  }
  if (new Set(zones).size !== zones.length) throw new Error("GATEWAY_VM_SPEC_JSON.zones must not repeat a zone");
}

export function parseGatewayVmSpec(raw: string | undefined): GatewayVmSpec {
  if (!raw?.trim()) throw new Error("GATEWAY_VM_SPEC_JSON is required for GCE Builder computers");
  const spec = JSON.parse(raw) as Partial<GatewayVmSpec>;
  const strings = ["machineType", "imageFamily", "serviceAccountEmail", "subnetwork"] as const;
  for (const key of strings) {
    if (typeof spec[key] !== "string" || spec[key].length === 0) throw new Error(`GATEWAY_VM_SPEC_JSON.${key} must be a non-empty string`);
  }
  if (spec.imageProject !== undefined && (typeof spec.imageProject !== "string" || spec.imageProject.length === 0)) {
    throw new Error("GATEWAY_VM_SPEC_JSON.imageProject must be a non-empty string when set");
  }
  if (typeof spec.diskSizeGb !== "number" || spec.diskSizeGb <= 0) throw new Error("GATEWAY_VM_SPEC_JSON.diskSizeGb must be a positive number");
  if (typeof spec.homeDiskSizeGb !== "number" || spec.homeDiskSizeGb <= 0) throw new Error("GATEWAY_VM_SPEC_JSON.homeDiskSizeGb must be a positive number");
  if (spec.provisioningModel !== "SPOT" && spec.provisioningModel !== "STANDARD") {
    throw new Error("GATEWAY_VM_SPEC_JSON.provisioningModel must be SPOT or STANDARD");
  }
  assertZones(spec.zones);
  return spec as GatewayVmSpec;
}

function runtimeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function hasObservedClusterPods(data: Record<string, unknown>): boolean {
  const observation = runtimeRecord(data.kubernetes);
  return ["ready", "not-ready"].includes(String(observation.status))
    && typeof observation.totalPods === "number" && observation.totalPods > 0;
}

function hasPriorClusterDeployment(data: Record<string, unknown>, gatewayId: string): boolean {
  const helm = runtimeRecord(data.helm);
  return data.docKind === "runtime" && data.gatewayId === gatewayId
    && helm.releaseName === `octogee-gw-${gatewayId}`
    && helm.deploymentName === `octogee-gateway-${gatewayId}`
    && typeof helm.lastAppliedAt === "number" && Number.isFinite(helm.lastAppliedAt) && helm.lastAppliedAt > 0;
}

function validateRuntimeObservation(data: Record<string, unknown>, gatewayId: string): void {
  if (data.runtime !== undefined && !isGatewayRuntime(data.runtime)) {
    throw new Error(`gateway ${gatewayId}: invalid runtime stamp ${String(data.runtime)}`);
  }
  const hasVm = data.vm != null || data.vmInstance != null;
  if (hasVm && data.runtime === undefined) throw new Error(`gateway ${gatewayId}: unstamped VM state requires operator reconciliation`);
  if ((hasVm && data.runtime === "cluster") || (data.runtime === "gce-vm" && hasObservedClusterPods(data))) {
    throw new Error(`gateway ${gatewayId}: conflicting cluster and VM runtime observations`);
  }
}

interface GatewayRuntimeStampInput {
  db: Pick<Firestore, "collection">;
  gatewayId: string;
  gatewayClass: string | null | undefined;
  sizingTier?: SizingTier | null;
  vmSpec: GatewayVmSpec | null;
  log: (msg: string) => void;
}

async function reconcileStampedVmSpec(input: GatewayRuntimeStampInput, data: Record<string, unknown>): Promise<void> {
  if (data.runtime !== "gce-vm" || input.gatewayClass !== "builder" || !input.vmSpec) return;
  const computer = resolveBuilderComputerPolicy(input.sizingTier);
  if (computer.runtime !== "gce-vm") return;
  const prior = runtimeRecord(data.vmSpec);
  if (prior.machineType === computer.machineType) return;
  await input.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId).set({
    vmSpec: { ...input.vmSpec, ...prior, machineType: computer.machineType },
  }, { merge: true });
}

export async function stampGatewayRuntime(input: GatewayRuntimeStampInput): Promise<GatewayRuntime> {
  const ref = input.db.collection(GLM_GATEWAYS_COLLECTION).doc(input.gatewayId);
  const snap = await ref.get();
  const data = runtimeRecord(snap.data());
  validateRuntimeObservation(data, input.gatewayId);
  if (isGatewayRuntime(data.runtime)) {
    await reconcileStampedVmSpec(input, data);
    return data.runtime;
  }
  const deployedCluster = hasObservedClusterPods(data) || hasPriorClusterDeployment(data, input.gatewayId);
  const computer = input.gatewayClass === "builder" && !deployedCluster ? resolveBuilderComputerPolicy(input.sizingTier) : null;
  const runtime: GatewayRuntime = computer?.runtime ?? "cluster";
  if (runtime === "gce-vm" && !input.vmSpec) throw new Error(`gateway ${input.gatewayId}: gce-vm runtime needs a vmSpec`);
  await ref.set({ runtime, ...(runtime === "gce-vm" ? { vmSpec: { ...input.vmSpec, machineType: computer?.machineType } } : {}) }, { merge: true });
  input.log(`[vm-gateway-runtime] ${input.gatewayId}: runtime stamped ${runtime}`);
  return runtime;
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function vmRoutesFromDocs(docs: Array<{ id: string; data: () => Record<string, unknown> | undefined }>): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const doc of docs) {
    const data = doc.data();
    if (resolveGatewayRuntime(data?.runtime) !== "gce-vm") continue;
    const vm = data?.vm as Partial<GatewayVmState> | null | undefined;
    if (vm && typeof vm.internalIp === "string" && vm.internalIp.length > 0 && vm.status === "RUNNING") {
      routes[doc.id] = vm.internalIp;
    }
  }
  return routes;
}

export function createVmGatewayRuntime(deps: VmGatewayRuntimeDeps): VmGatewayRuntime {
  const upgradeTimeout = deps.upgradeTimeout ?? "10m";
  const glm = (gatewayId: string) => deps.db.collection(GLM_GATEWAYS_COLLECTION).doc(gatewayId);

  async function kubectl(args: string[], stdin?: string): Promise<string> {
    const result = await deps.runKubectl(args, stdin === undefined ? undefined : { stdin });
    if (result.code !== 0) {
      throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed (code=${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout;
  }

  async function readSecret(name: string, key: string): Promise<string> {
    const raw = (await kubectl(["get", "secret", name, "-n", deps.namespace, "-o", `jsonpath={.data.${key.replace(/\./g, "\\.")}}`])).trim();
    if (!raw) throw new Error(`secret ${name}/${key} in ${deps.namespace} is empty or missing`);
    return Buffer.from(raw, "base64").toString("utf8");
  }

  async function bridgeIp(): Promise<string> {
    const ip = (await kubectl(["get", "svc", deps.bridgeServiceName, "-n", deps.namespace, "-o", "jsonpath={.status.loadBalancer.ingress[0].ip}"])).trim();
    if (!ip) throw new Error(`service ${deps.bridgeServiceName} in ${deps.namespace} has no internal load balancer IP yet`);
    return ip;
  }

  async function renderManifests(opts: Parameters<HelmRunner["upsertInstance"]>[0]): Promise<unknown[]> {
    const release = `octogee-gw-${opts.revisionId ?? opts.gatewayId}`;
    const args = [...helmTemplateArgsFromUpgradeArgs(buildUpgradeArgs({ ...opts, release, upgradeTimeout })), "--set", "computerDesktop=omarchy"];
    const rendered = await deps.runHelm(args);
    if (rendered.code !== 0) {
      throw new Error(`helm template ${release} failed (code=${rendered.code}): ${rendered.stderr.trim() || rendered.stdout.trim()}`);
    }
    return parseConcatenatedJson(await kubectl(["create", "--dry-run=client", "-o", "json", "-f", "-"], rendered.stdout));
  }

  async function reconcileRoutes(): Promise<void> {
    const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).where("runtime", "==", "gce-vm").get();
    const routes = vmRoutesFromDocs(snap.docs);
    const manifest = JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: deps.routesConfigMap,
        namespace: deps.namespace,
        labels: { "app.kubernetes.io/managed-by": "glm-controller", "octogee.ai/controller": "cowboy" },
      },
      data: { [VM_ROUTES_CONFIGMAP_KEY]: JSON.stringify(routes) },
    });
    await kubectl(["apply", "-n", deps.namespace, "-f", "-"], `${manifest}\n`);
    deps.log(`[vm-gateway-runtime] routes reconciled: ${Object.keys(routes).length} VM gateway(s)`);
  }

  const computers = createComputerLifecycle({
    db: deps.db,
    vm: deps.vm,
    environment: deps.environment,
    vmSpec: deps.vmSpec,
    readDesiredStatus: deps.readDesiredStatus,
    reconcileRoutes,
    wait: deps.wait,
    homeCheckpointTimeoutMs: deps.homeCheckpointTimeoutMs,
    homeCheckpointPollMs: deps.homeCheckpointPollMs,
    now: deps.now,
    log: deps.log,
  });

  return {
    async readDeployedInstances() {
      const snap = await deps.db.collection(GLM_GATEWAYS_COLLECTION).where("runtime", "==", "gce-vm").get();
      const entries: Array<[string, HelmInstancesMap[string]]> = [];
      for (const doc of snap.docs) {
        const instance = (doc.data() as Record<string, unknown>).vmInstance as HelmInstancesMap[string] | undefined;
        if (instance) entries.push([doc.id, instance]);
      }
      return Object.fromEntries(entries);
    },

    async readDeployedInstance({ gatewayId }) {
      const snap = await glm(gatewayId).get();
      const instance = snap.exists ? ((snap.data() as Record<string, unknown>).vmInstance as HelmInstancesMap[string] | undefined) : undefined;
      return instance ?? null;
    },

    async upsertInstance(opts) {
      const { gatewayId } = opts;
      if (deps.ensureAuthSecret) await deps.ensureAuthSecret({ namespace: deps.namespace, gatewayId });
      const [manifests, bridge] = await Promise.all([renderManifests(opts), bridgeIp()]);
      const bundle = await renderVmRuntimeBundle({
        gatewayId,
        namespace: deps.namespace,
        imageRepository: opts.imageRepository,
        imageTag: opts.imageTag,
        computer: { serviceAccountEmail: deps.vmSpec.serviceAccountEmail, projectId: deps.computeProjectId },
        manifests,
        readSecret,
        hostAliases: Object.fromEntries(deps.hostAliasNames.map((name) => [name, bridge])),
        kubernetes: deps.kubernetes,
        now: deps.now,
      });
      const instance: HelmInstancesMap[string] = withoutUndefined({
        enabled: true,
        image: { repository: opts.imageRepository, tag: opts.imageTag },
        gatewayId,
        chartFingerprint: opts.chartFingerprint,
        deploymentIntentFingerprint: opts.deploymentIntentFingerprint,
        serviceAccountName: opts.serviceAccountName,
        serviceAccount: opts.serviceAccount,
        gatewayContainerSecurityContext: opts.gatewayContainerSecurityContext,
        builderAccess: opts.builderAccess,
        profile: opts.profile,
        gatewayClass: opts.gatewayClass,
        imageProfile: opts.imageProfile,
        ownerUid: opts.ownerUid,
        builderSlug: opts.builderSlug,
        sizingTier: opts.sizingTier,
        replicas: opts.replicas,
      });
      if (opts.replicas === 0) {
        await computers.pauseComputer(gatewayId);
      } else {
        await computers.ensureVm(gatewayId, `${opts.imageRepository}:${opts.imageTag}`, opts.ownerUid, bridge);
      }
      await deps.db.doc(gatewayVmRuntimeDocPath(gatewayId)).set(bundle);
      deps.log(`[vm-gateway-runtime] ${gatewayId}: runtime bundle ${bundle.version} rendered (${opts.imageTag})`);
      await reconcileRoutes();
      await glm(gatewayId).set({ vmInstance: instance }, { merge: true });
    },

    async removeInstance({ gatewayId, awaitHomeCheckpoint }) {
      const parked = await computers.parkComputer(gatewayId, { awaitHomeCheckpoint: awaitHomeCheckpoint === true });
      await deps.db.doc(gatewayVmRuntimeDocPath(gatewayId)).delete();
      await recordVmObservation(deps, gatewayId, { vm: parked, vmInstance: FieldValue.delete() }, "park");
      await reconcileRoutes();
    },

    async listPendingReleases() {
      return [];
    },

    async recoverRelease({ gatewayId }) {
      return `${gatewayId}: VM runtime has no Helm release to recover`;
    },

    readDeploymentPrerequisiteError: computers.readDeploymentPrerequisiteError,
    recoverUnreachable: computers.recoverUnreachable,
    deleteComputer: computers.deleteComputer,
    detectPreemption: computers.detectPreemption,
  };
}

export function createRuntimeDispatchingHelmRunner(input: {
  cluster: HelmRunner;
  vm: HelmRunner;
  isVmGateway: (gatewayId: string) => Promise<boolean>;
}): HelmRunner {
  const pick = async (gatewayId: string) => ((await input.isVmGateway(gatewayId)) ? input.vm : input.cluster);
  async function assertObservedRuntime(gatewayId: string, hasCluster: boolean, hasVm: boolean): Promise<void> {
    const vmStamped = await input.isVmGateway(gatewayId);
    if ((hasCluster && hasVm) || (vmStamped && hasCluster) || (!vmStamped && hasVm)) {
      throw new Error(`gateway ${gatewayId}: conflicting cluster and VM deployments or runtime stamp`);
    }
  }
  return {
    async readDeployedInstances(opts) {
      const [cluster, vm] = await Promise.all([input.cluster.readDeployedInstances(opts), input.vm.readDeployedInstances(opts)]);
      await Promise.all([...new Set([...Object.keys(cluster), ...Object.keys(vm)])]
        .map((gatewayId) => assertObservedRuntime(gatewayId, Boolean(cluster[gatewayId]), Boolean(vm[gatewayId]))));
      return { ...cluster, ...vm };
    },
    async readDeployedInstance(opts) {
      const [cluster, vm] = await Promise.all([input.cluster.readDeployedInstance(opts), input.vm.readDeployedInstance(opts)]);
      await assertObservedRuntime(opts.gatewayId, Boolean(cluster), Boolean(vm));
      return cluster ?? vm;
    },
    async upsertInstance(opts) {
      return (await pick(opts.gatewayId)).upsertInstance(opts);
    },
    async removeInstance(opts) {
      return (await pick(opts.gatewayId)).removeInstance(opts);
    },
    listPendingReleases: (opts) => input.cluster.listPendingReleases(opts),
    async recoverRelease(opts) {
      return (await pick(opts.gatewayId)).recoverRelease(opts);
    },
  };
}
