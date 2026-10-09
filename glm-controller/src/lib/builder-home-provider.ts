import type { Firestore } from "firebase-admin/firestore";
import type { KubectlSubprocess } from "../fleet-ingress.js";
import { hobbyHomeClaimName } from "../hobby-home.js";
import type { BuilderHomeLocation, BuilderHomeMigrationDeps, BuilderHomeOwner } from "../builder-home-migration.js";
import type { ComputeRequest, GatewayVmClient } from "./compute-vm.js";
import type { ClusterHomeTarget, CopyHomeDisk, HomeCopyInput } from "./compute-home-copy.js";

interface ResourceMetadata {
  name: string; uid: string; resourceVersion: string; deletionTimestamp?: string; annotations?: Record<string, string>;
}
interface KubeHomeResource {
  metadata: ResourceMetadata;
  spec: {
    accessModes?: string[]; volumeName?: string; persistentVolumeReclaimPolicy?: string;
    storageClassName?: string; resources?: { requests?: { storage?: string } };
    claimRef?: { uid?: string; namespace: string; name: string };
    csi?: { driver?: string; volumeHandle?: string; fsType?: string };
    volumes?: Array<{ persistentVolumeClaim?: { claimName: string } }>;
  };
  status?: { phase?: string };
  items?: KubeHomeResource[];
}
interface ComputeHomeResource {
  id?: string; sizeGb?: string; type?: string; users?: string[]; labels?: Record<string, string>;
  disks?: Array<{ deviceName?: string; source: string; boot?: boolean; autoDelete?: boolean }>;
}
interface HomeProviderDeps {
  db: Firestore;
  projectId: string;
  namespace: string;
  environment: string;
  request: ComputeRequest;
  vm: GatewayVmClient;
  kubectl: KubectlSubprocess;
  journal: <T>(what: string, uid: string, action: () => Promise<T>) => Promise<T>;
}
type ObservedHomeDisk = CopyHomeDisk & { users?: string[]; ownerUid?: string };
const IGNORE_MISSING = "--ignore-not-found";
const RWOP = "ReadWriteOncePod";
const OWNER_ANNOTATION = "octogee.ai/owner-uid";

class BuilderHomeProvider {
  constructor(private readonly deps: HomeProviderDeps) {}
  private get base() { return `https://compute.googleapis.com/compute/v1/projects/${this.deps.projectId}`; }
  async kube(args: string[], body?: unknown): Promise<KubeHomeResource | null> {
    const result = await this.deps.kubectl(args, body === undefined ? undefined : { stdin: JSON.stringify(body) });
    if (result.code !== 0) throw new Error(`home storage Kubernetes request failed: ${result.stderr || result.stdout}`);
    const output = result.stdout.trim();
    return output.startsWith("{") || output.startsWith("[") ? JSON.parse(output) : null;
  }
  async compute(url: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<ComputeHomeResource> {
    const response = await this.deps.request({ url, method, ...(body === undefined ? {} : { body }) });
    if (response.status >= 400) throw Object.assign(new Error(`home storage Compute request failed: HTTP ${response.status}`), { response: { status: response.status } });
    return response.data as ComputeHomeResource;
  }
  async disk(source: string): Promise<CopyHomeDisk & { users?: string[]; ownerUid?: string }> {
    const match = /^projects\/([a-z][a-z0-9-]+)\/zones\/([a-z][a-z0-9-]+)\/disks\/([a-z][a-z0-9-]+)$/u.exec(source.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//u, ""));
    if (!match || match[1] !== this.deps.projectId) throw new Error("home disk escaped the configured project");
    const value = await this.compute(`${this.base}/zones/${match[2]}/disks/${match[3]}`, "GET");
    const sizeGb = Number(value.sizeGb);
    const diskType = value.type?.split("/").at(-1);
    if (!/^\d+$/u.test(value.id ?? "") || !Number.isSafeInteger(sizeGb) || sizeGb < 10 || !["pd-balanced", "pd-ssd"].includes(diskType ?? "")) throw new Error("home disk identity or capacity is incomplete");
    return { projectId: this.deps.projectId, zone: match[2], name: match[3], id: value.id!, sizeGb, diskType: diskType as CopyHomeDisk["diskType"], source: `projects/${this.deps.projectId}/zones/${match[2]}/disks/${match[3]}`, ...(value.users ? { users: value.users } : {}), ...(value.labels?.["octogee-owner-uid"] ? { ownerUid: value.labels["octogee-owner-uid"] } : {}) };
  }
  async claim(uid: string, slug: string, selected?: BuilderHomeLocation["claim"]): Promise<KubeHomeResource | null> {
    const found = await this.kube(["-n", this.deps.namespace, "get", "pvc", selected?.name ?? hobbyHomeClaimName(slug), IGNORE_MISSING, "-o", "json"]);
    if (found && (found.metadata?.annotations?.[OWNER_ANNOTATION] !== uid || !found.metadata.uid || found.spec?.accessModes?.join(",") !== RWOP)) throw new Error("home claim owner or mount policy differs");
    if (selected && (!found || found.metadata.uid !== selected.uid || found.spec.volumeName !== selected.volumeName)) throw new Error("primary home claim identity changed");
    return found;
  }
  async assertClaimUnused(name: string): Promise<void> {
    const pods = await this.kube(["-n", this.deps.namespace, "get", "pods", "-o", "json"]);
    if (!Array.isArray(pods?.items)) throw new Error("home pod inventory is unavailable");
    if (pods.items.some((pod) => !["Succeeded", "Failed"].includes(pod.status?.phase ?? "") && pod.spec?.volumes?.some((volume) => volume.persistentVolumeClaim?.claimName === name))) throw new Error("home migration requires the source pod to be gone");
  }
  async ownedComputer(uid: string) {
    const computer = await this.deps.vm.findByLabels({ "octogee-owner-uid": uid.toLowerCase(), "octogee-environment": this.deps.environment, purpose: "octogee-computer" });
    if (computer && (computer.metadata["octogee-owner-uid"] !== uid || !computer.instanceId || !["STOPPED", "TERMINATED"].includes(computer.status))) throw new Error("home migration requires a verified stopped owner computer");
    return computer;
  }
  async clusterInventory(pvc: KubeHomeResource | null, primary?: BuilderHomeLocation): Promise<BuilderHomeLocation> {
    if (!pvc?.spec?.volumeName) throw new Error("home claim is not bound");
    const pv = await this.requireKube(["get", "pv", pvc.spec.volumeName, "-o", "json"]);
    if (pv.spec?.claimRef?.uid !== pvc.metadata.uid || pv.spec.claimRef.namespace !== this.deps.namespace || pv.spec.csi?.driver !== "pd.csi.storage.gke.io") throw new Error("home volume binding changed");
    const observed = await this.disk(pv.spec.csi.volumeHandle ?? "");
    if (primary && primary.disk.id !== observed.id) throw new Error("primary home claim disk changed");
    return { runtime: "cluster", disk: observed, layout: primary?.layout ?? "flat", claim: { name: pvc.metadata.name, uid: pvc.metadata.uid, volumeName: pvc.spec.volumeName } };
  }
  async nativeInventory(uid: string, selected?: CopyHomeDisk): Promise<BuilderHomeLocation> {
    if (!selected) throw new Error("native home identity is missing");
    const observed = await this.disk(selected.source);
    if (observed.id !== selected.id) throw new Error("primary native home disk changed");
    const computer = await this.ownedComputer(uid);
    return { runtime: "gce-vm", disk: observed, layout: "portable", ...(computer ? { computer: { name: computer.name, zone: computer.zone, id: computer.instanceId! } } : {}) };
  }
  async primaryClaim(uid: string, slug: string, primary?: BuilderHomeLocation): Promise<KubeHomeResource | null> {
    if (primary?.runtime === "cluster" && !primary.claim) throw new Error("primary home claim identity is missing");
    return this.claim(uid, slug, primary?.runtime === "cluster" ? primary.claim : undefined);
  }
  async inventory(uid: string, slug: string, owner: BuilderHomeOwner): Promise<BuilderHomeLocation | null> {
    const migration = owner.provisioning?.homeMigration;
    if (migration?.phase === "adopting") return migration.source;
    const primary = owner.provisioning?.homeStorage;
    const pvc = await this.primaryClaim(uid, slug, primary);
    const home = owner.provisioning?.homeDisk;
    if (!primary && pvc && home) throw new Error("multiple homes have no recorded primary storage");
    if (primary) {
      if (primary.runtime === "cluster") return this.clusterInventory(pvc, primary);
      if (primary.runtime === "gce-vm") return this.nativeInventory(uid, primary.disk);
      throw new Error("invalid primary home runtime");
    }
    if (pvc) return this.clusterInventory(pvc);
    return home ? this.nativeInventory(uid, home) : null;
  }
  async verifyStopped(uid: string, source: BuilderHomeLocation): Promise<void> {
    const observed = await this.disk(source.disk.source);
    if (observed.id !== source.disk.id) throw new Error("source home disk changed");
    if (source.runtime === "cluster") return this.verifyClusterStopped(uid, source, observed);
    const computer = await this.ownedComputer(uid);
    if (source.computer && (!computer || computer.instanceId !== source.computer.id || computer.name !== source.computer.name || computer.zone !== source.computer.zone)) throw new Error("source computer identity changed");
    if (observed.users?.some(user => !computer || !user.endsWith(`/zones/${computer.zone}/instances/${computer.name}`))) throw new Error("source home is attached to another computer");
  }
  async verifyClusterStopped(uid: string, source: BuilderHomeLocation, observed: ObservedHomeDisk): Promise<void> {
    if (!source.claim) throw new Error("source home has no claim identity");
    const current = await this.requireKube(["-n", this.deps.namespace, "get", "pvc", source.claim.name, "-o", "json"]);
    if (current.metadata.uid !== source.claim.uid || current.metadata.annotations?.[OWNER_ANNOTATION] !== uid) throw new Error("source home claim changed");
    await this.assertClaimUnused(source.claim.name);
    if (observed.users?.length) throw new Error("source home is still attached to a Kubernetes node");
  }
  async detachForAdoption(uid: string, target: CopyHomeDisk, attached: NonNullable<ComputeHomeResource["disks"]>[number], url: string): Promise<boolean> {
    const old = await this.disk(attached.source);
    if (old.id === target.id) {
      if (attached.autoDelete !== false) throw new Error("adopted home has auto-delete enabled");
      return true;
    }
    const owner = (await this.deps.db.collection("users").doc(uid).get()).data() as BuilderHomeOwner | undefined;
    if (old.id !== owner?.provisioning?.homeDisk?.id || attached.autoDelete !== false) throw new Error("retained computer home identity changed");
    await this.deps.journal("detach-retained-builder-home", uid, () => this.compute(`${url}/detachDisk?deviceName=octogee-home`, "POST"));
    return false;
  }
  async adoptNative(uid: string, target: CopyHomeDisk): Promise<boolean> {
    const current = await this.disk(target.source);
    if (current.id !== target.id) throw new Error("verified home target changed");
    const computer = await this.ownedComputer(uid);
    if (!computer) {
      if (current.users?.length) throw new Error("home target is attached elsewhere");
      return true;
    }
    const url = `${this.base}/zones/${computer.zone}/instances/${computer.name}`;
    if (computer.zone !== target.zone) throw new Error("home target and retained computer zones differ");
    const instance = await this.compute(url, "GET");
    if (instance.id !== computer.instanceId) throw new Error("computer changed before home adoption");
    const attached = instance.disks?.find((entry) => entry.deviceName === "octogee-home" && !entry.boot);
    if (attached) return this.detachForAdoption(uid, target, attached, url);
    if (current.users?.length) throw new Error("verified home target is attached elsewhere");
    await this.deps.journal("attach-verified-builder-home", uid, () => this.compute(`${url}/attachDisk`, "POST", { source: target.source, deviceName: "octogee-home", mode: "READ_WRITE", autoDelete: false }));
    return false;
  }
  async deleteClaim(uid: string, resource: KubeHomeResource, operation: string): Promise<void> {
    await this.deps.journal(operation, uid, () => this.kube(["delete", "--raw", `/api/v1/namespaces/${this.deps.namespace}/persistentvolumeclaims/${resource.metadata.name}`, "-f", "-"], {
      apiVersion: "v1", kind: "DeleteOptions", preconditions: { uid: resource.metadata.uid, resourceVersion: resource.metadata.resourceVersion },
    }));
  }
  async copyClaim(input: HomeCopyInput): Promise<KubeHomeResource | null> {
    const claim = await this.kube(["-n", this.deps.namespace, "get", "pvc", `${input.operationId}-home`, IGNORE_MISSING, "-o", "json"]);
    if (claim && (claim.metadata.annotations?.[OWNER_ANNOTATION] !== input.ownerUid ||
        claim.metadata.annotations?.["octogee.ai/home-copy"] !== input.operationId || !claim.metadata.uid ||
        claim.spec.accessModes?.join(",") !== RWOP || claim.spec.storageClassName !== this.copyStorageClass(input))) throw new Error("home copy claim owner or configuration changed");
    return claim;
  }
  copyStorageClass(input: HomeCopyInput): string {
    return `octogee-home-${this.deps.namespace}-${input.targetZone}`;
  }
  async readClusterTarget(input: HomeCopyInput): Promise<CopyHomeDisk | null> {
    const claim = await this.copyClaim(input);
    if (!claim || claim.metadata.deletionTimestamp || claim.status?.phase !== "Bound") return null;
    const home = await this.clusterInventory(claim);
    const pv = await this.requireKube(["get", "pv", home.claim!.volumeName, "-o", "json"]);
    if (pv.spec.persistentVolumeReclaimPolicy !== "Delete" || pv.spec.csi?.fsType !== "ext4" || home.disk.zone !== input.targetZone) throw new Error("home copy CSI target configuration changed");
    return { ...home.disk, claim: home.claim };
  }
  async ensureClusterTarget(input: HomeCopyInput, sizeGb: number): Promise<CopyHomeDisk | null> {
    const claim = await this.copyClaim(input);
    if (!claim) {
      await this.deps.journal("create-builder-home-copy-claim", input.ownerUid, () => this.kube(["create", "-f", "-", "-o", "json"], {
        apiVersion: "v1", kind: "PersistentVolumeClaim",
        metadata: { name: `${input.operationId}-home`, namespace: this.deps.namespace,
          annotations: { [OWNER_ANNOTATION]: input.ownerUid, "octogee.ai/home-copy": input.operationId } },
        spec: { accessModes: [RWOP], storageClassName: this.copyStorageClass(input), resources: { requests: { storage: `${sizeGb}Gi` } } },
      }));
      return null;
    }
    if (claim.spec.resources?.requests?.storage !== `${sizeGb}Gi`) throw new Error("home copy claim capacity changed");
    const target = await this.readClusterTarget(input);
    if (target && target.sizeGb !== sizeGb) throw new Error("home copy target capacity changed");
    return target;
  }
  async removeClusterTarget(input: HomeCopyInput): Promise<boolean> {
    const claim = await this.copyClaim(input);
    if (!claim) return true;
    if (claim.spec.volumeName) return this.removeStoppedHome(input.ownerUid, await this.clusterInventory(claim));
    await this.assertClaimUnused(claim.metadata.name);
    await this.deleteClaim(input.ownerUid, claim, "remove-pending-home-copy-claim");
    return false;
  }
  async adoptCluster(uid: string, target: CopyHomeDisk, operationId: string): Promise<boolean> {
    if (!target.claim || target.claim.name !== `${operationId}-home`) throw new Error("verified target has no home claim identity");
    const current = await this.claim(uid, "unused", target.claim);
    const observed = await this.clusterInventory(current);
    if (observed.disk.id !== target.id || observed.disk.source !== target.source || (observed.disk as ObservedHomeDisk).users?.length) throw new Error("verified target home identity changed or is already attached");
    await this.assertClaimUnused(target.claim.name);
    return current?.status?.phase === "Bound";
  }
  async adopt(input: Parameters<BuilderHomeMigrationDeps["adopt"]>[0]): Promise<boolean> {
    return input.runtime === "cluster" ? this.adoptCluster(input.uid, input.target, input.operationId) : this.adoptNative(input.uid, input.target);
  }
  async observedForRemoval(uid: string, source: BuilderHomeLocation): Promise<ObservedHomeDisk | null> {
    let observed: ObservedHomeDisk;
    try { observed = await this.disk(source.disk.source); }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status !== 404) throw error;
      return null;
    }
    if (observed.id !== source.disk.id) throw new Error("retained home identity changed before cleanup");
    if ((observed.ownerUid && observed.ownerUid !== uid.toLowerCase()) || (source.runtime === "gce-vm" && observed.ownerUid !== uid.toLowerCase())) throw new Error("retained home owner changed before cleanup");
    return observed;
  }
  assertCleanupVolume(pv: KubeHomeResource, source: BuilderHomeLocation): void {
    if (pv.spec.csi?.driver !== "pd.csi.storage.gke.io" || pv.spec.csi.volumeHandle !== source.disk.source ||
        pv.spec.claimRef?.uid !== source.claim!.uid || pv.spec.claimRef.namespace !== this.deps.namespace || pv.spec.claimRef.name !== source.claim!.name) throw new Error("retained volume binding changed before cleanup");
    if (pv.spec.persistentVolumeReclaimPolicy !== "Delete") throw new Error("static retained home requires one-time operator conversion before cleanup");
  }
  async removeClusterHome(uid: string, source: BuilderHomeLocation, observed: ObservedHomeDisk | null): Promise<boolean> {
    if (!source.claim) throw new Error("cluster home cleanup requires its recorded claim identity");
    const current = await this.kube(["-n", this.deps.namespace, "get", "pvc", source.claim.name, IGNORE_MISSING, "-o", "json"]);
    const pv = await this.kube(["get", "pv", source.claim.volumeName, IGNORE_MISSING, "-o", "json"]);
    if (pv) this.assertCleanupVolume(pv, source);
    if (current?.metadata.uid === source.claim.uid) {
      if (current.metadata.annotations?.[OWNER_ANNOTATION] !== uid || current.spec.volumeName !== source.claim.volumeName || !pv) throw new Error("retained claim owner/binding changed before cleanup");
      await this.assertClaimUnused(source.claim.name);
      if (observed?.users?.length) throw new Error("retained home is still attached to a Kubernetes node");
      if (!current.metadata.deletionTimestamp) await this.deleteClaim(uid, current, "remove-retained-home-claim");
      return false;
    }
    return !pv && !observed;
  }
  async detachForRemoval(uid: string, source: BuilderHomeLocation, observed: ObservedHomeDisk): Promise<void> {
    if (source.runtime !== "gce-vm") throw new Error("retained home is still attached to a Kubernetes node");
    const computer = await this.ownedComputer(uid);
    if (!computer || !source.computer || computer.instanceId !== source.computer.id || observed.users!.length !== 1 || !observed.users![0].endsWith(`/zones/${computer.zone}/instances/${computer.name}`)) throw new Error("retained home is attached to an unverified computer");
    const url = `${this.base}/zones/${computer.zone}/instances/${computer.name}`;
    const instance = await this.compute(url, "GET");
    const attached = instance.disks?.find(entry => entry.deviceName === "octogee-home" && !entry.boot);
    if (instance.id !== computer.instanceId || !attached || attached.autoDelete !== false || (await this.disk(attached.source)).id !== source.disk.id) throw new Error("retained home attachment changed before cleanup");
    await this.deps.journal("detach-expired-builder-home", uid, () => this.compute(`${url}/detachDisk?deviceName=octogee-home`, "POST"));
  }
  async removeStoppedHome(uid: string, source: BuilderHomeLocation): Promise<boolean> {
    const observed = await this.observedForRemoval(uid, source);
    if (source.runtime === "cluster") return this.removeClusterHome(uid, source, observed);
    if (!observed) return true;
    if (observed.users?.length) await this.detachForRemoval(uid, source, observed);
    else await this.deps.journal("remove-retained-builder-home", uid, () => this.compute(`${this.base}/zones/${observed.zone}/disks/${observed.name}`, "DELETE"));
    return false;
  }
  async requireKube(args: string[]): Promise<KubeHomeResource> {
    const resource = await this.kube(args);
    if (!resource) throw new Error("home storage Kubernetes resource is missing");
    return resource;
  }
}

export function createBuilderHomeProvider(deps: HomeProviderDeps): Pick<BuilderHomeMigrationDeps, "inventory" | "verifyStopped" | "adopt" | "nativeZone" | "removeStoppedHome"> & { clusterTarget: ClusterHomeTarget } {
  const provider = new BuilderHomeProvider(deps);
  return {
    inventory: provider.inventory.bind(provider), verifyStopped: provider.verifyStopped.bind(provider),
    adopt: provider.adopt.bind(provider), removeStoppedHome: provider.removeStoppedHome.bind(provider),
    clusterTarget: { ensure: provider.ensureClusterTarget.bind(provider), read: provider.readClusterTarget.bind(provider), remove: provider.removeClusterTarget.bind(provider) },
    nativeZone: async uid => (await provider.ownedComputer(uid))?.zone ?? null,
  };
}
