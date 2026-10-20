import type { Firestore } from "firebase-admin/firestore";
import type { BuilderHomeLocation, BuilderHomeMigrationDeps, BuilderHomeOwner } from "../builder-home-migration.js";
import type { ComputeRequest, GatewayVmClient } from "./compute-vm.js";
import { PARKED_STATUSES, STOPPED_STATUSES } from "../vm-computer-lifecycle.js";
import type { CopyHomeDisk } from "./compute-home-copy.js";

interface ComputeHomeResource {
  id?: string; sizeGb?: string; type?: string; users?: string[]; labels?: Record<string, string>; status?: string;
  metadata?: { items?: Array<{ key?: string; value?: string }> };
  disks?: Array<{ deviceName?: string; source: string; boot?: boolean; autoDelete?: boolean }>;
  items?: Record<string, { disks?: Array<{ selfLink?: string; name?: string }> }>;
}
interface HomeProviderDeps {
  db: Firestore;
  projectId: string;
  environment: string;
  request: ComputeRequest;
  vm: GatewayVmClient;
  journal: <T>(what: string, uid: string, action: () => Promise<T>) => Promise<T>;
}
type ObservedHomeDisk = CopyHomeDisk & { users?: string[]; ownerUid?: string };
type LegacyComputer = NonNullable<NonNullable<BuilderHomeOwner["provisioning"]>["computer"]>;

function assertLegacyInstance(instance: ComputeHomeResource, uid: string, recorded: LegacyComputer, environment: string): void {
  if (![instance.id === recorded.instanceId, instance.status === "TERMINATED",
    instance.metadata?.items?.find(item => item.key === "octogee-owner-uid")?.value === uid,
    instance.labels?.["octogee-owner-uid"] === uid.toLowerCase(), instance.labels?.["octogee-environment"] === environment,
    instance.labels?.purpose === "octogee-computer"].every(Boolean)) throw new Error("legacy home computer owner or stopped identity changed");
}
function assertLegacyDisk(disk: ObservedHomeDisk, uid: string, recorded: LegacyComputer, instanceSource: string): void {
  if (![disk.zone === recorded.zone, disk.ownerUid === undefined || disk.ownerUid === uid.toLowerCase(),
    Array.isArray(disk.users) && disk.users.length === 1 && disk.users[0]!.replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//u, "") === instanceSource].every(Boolean)) {
    throw new Error("legacy home disk owner, zone or attachment changed");
  }
}
function assertNativeHome(home: BuilderHomeLocation): void {
  if (home.runtime !== "gce-vm") throw new Error("home record is not a native home; retired cluster home records need operator cleanup");
}

class BuilderHomeProvider {
  constructor(private readonly deps: HomeProviderDeps) {}
  private get base() { return `https://compute.googleapis.com/compute/v1/projects/${this.deps.projectId}`; }
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
  async ownedComputer(uid: string, accepted: ReadonlySet<string> = STOPPED_STATUSES) {
    const computer = await this.deps.vm.findByLabels({ "octogee-owner-uid": uid.toLowerCase(), "octogee-environment": this.deps.environment, purpose: "octogee-computer" });
    if (computer && (computer.metadata["octogee-owner-uid"] !== uid || !computer.instanceId || !accepted.has(computer.status))) throw new Error("home migration requires a verified stopped owner computer");
    return computer;
  }
  async stoppedOwnedComputer(uid: string) {
    const computer = await this.ownedComputer(uid, PARKED_STATUSES);
    if (computer?.status !== "SUSPENDED") return computer;
    await this.deps.journal("stop-suspended-builder-computer", uid, () => this.deps.vm.stop(computer.name, computer.zone));
    const stopped = await this.ownedComputer(uid);
    if (stopped?.instanceId !== computer.instanceId) throw new Error("suspended owner computer changed while stopping for home migration");
    return stopped;
  }
  async nativeInventory(uid: string, selected?: CopyHomeDisk): Promise<BuilderHomeLocation> {
    if (!selected) throw new Error("native home identity is missing");
    const observed = await this.disk(selected.source);
    if (observed.id !== selected.id) throw new Error("primary native home disk changed");
    const computer = await this.ownedComputer(uid, PARKED_STATUSES);
    return { runtime: "gce-vm", disk: observed, layout: "portable", ...(computer ? { computer: { name: computer.name, zone: computer.zone, id: computer.instanceId! } } : {}) };
  }
  async legacySource(uid: string, recorded: LegacyComputer) {
    const computer = await this.ownedComputer(uid);
    if (![computer?.name === recorded.instanceName, computer?.instanceId === recorded.instanceId,
      computer?.zone === recorded.zone, computer?.status === "TERMINATED"].every(Boolean)) throw new Error("legacy home computer identity changed");
    const instanceSource = `projects/${this.deps.projectId}/zones/${recorded.zone}/instances/${recorded.instanceName}`;
    const instance = await this.compute(`https://compute.googleapis.com/compute/v1/${instanceSource}`, "GET");
    assertLegacyInstance(instance, uid, recorded, this.deps.environment);
    const homes = instance.disks?.filter(entry => entry.deviceName === "octogee-home") ?? [];
    if (homes.length !== 1 || homes[0]!.boot !== false || typeof homes[0]!.autoDelete !== "boolean") throw new Error("legacy computer has no unique nonboot home attachment");
    const attached = homes[0]!, disk = await this.disk(attached.source);
    assertLegacyDisk(disk, uid, recorded, instanceSource);
    return { attached, disk };
  }
  async legacyInventory(uid: string, recorded: LegacyComputer): Promise<BuilderHomeLocation> {
    if (![typeof recorded.instanceName === "string", /^[a-z][a-z0-9-]{0,62}$/u.test(recorded.instanceName),
      /^\d+$/u.test(recorded.instanceId), typeof recorded.zone === "string", /^[a-z][a-z0-9-]+$/u.test(recorded.zone)].every(Boolean)) {
      throw new Error("legacy computer identity is incomplete");
    }
    const source = await this.legacySource(uid, recorded);
    if (source.attached.autoDelete !== false || source.disk.ownerUid !== uid.toLowerCase()) {
      await this.deps.journal("retain-legacy-builder-home", uid, async () => {
        const before = await this.legacySource(uid, recorded);
        if (before.disk.id !== source.disk.id || before.disk.source !== source.disk.source) throw new Error("legacy home disk identity changed before retention");
        const retained = await this.deps.vm.retainHome(recorded.instanceName, recorded.zone, uid);
        if (retained.id !== source.disk.id || retained.source !== source.disk.source) throw new Error("legacy home disk identity changed during retention");
      });
    }
    const confirmed = await this.legacySource(uid, recorded);
    if (confirmed.attached.autoDelete !== false || confirmed.disk.ownerUid !== uid.toLowerCase() ||
      confirmed.disk.id !== source.disk.id || confirmed.disk.source !== source.disk.source) throw new Error("legacy home retention did not converge");
    return { runtime: "gce-vm", layout: "flat", disk: confirmed.disk,
      computer: { name: recorded.instanceName, id: recorded.instanceId, zone: recorded.zone } };
  }
  async inventory(uid: string, owner: BuilderHomeOwner): Promise<BuilderHomeLocation | null> {
    const migration = owner.provisioning?.homeMigration;
    if (migration?.phase === "adopting") return migration.source;
    const primary = owner.provisioning?.homeStorage;
    const home = owner.provisioning?.homeDisk;
    const computer = owner.provisioning?.computer;
    if (primary) {
      assertNativeHome(primary);
      return this.nativeInventory(uid, primary.disk);
    }
    if (home) return this.nativeInventory(uid, home);
    return computer ? this.legacyInventory(uid, computer) : null;
  }
  async verifyStopped(uid: string, source: BuilderHomeLocation): Promise<void> {
    assertNativeHome(source);
    const observed = await this.disk(source.disk.source);
    if (observed.id !== source.disk.id) throw new Error("source home disk changed");
    const computer = await this.stoppedOwnedComputer(uid);
    if (source.computer && (!computer || computer.instanceId !== source.computer.id || computer.name !== source.computer.name || computer.zone !== source.computer.zone)) throw new Error("source computer identity changed");
    if (observed.users?.some(user => !computer || !user.endsWith(`/zones/${computer.zone}/instances/${computer.name}`))) throw new Error("source home is attached to another computer");
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
    const computer = await this.stoppedOwnedComputer(uid);
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
  async adopt(input: Parameters<BuilderHomeMigrationDeps["adopt"]>[0]): Promise<boolean> {
    return this.adoptNative(input.uid, input.target);
  }
  async observedForRemoval(uid: string, source: BuilderHomeLocation): Promise<ObservedHomeDisk | null> {
    let observed: ObservedHomeDisk;
    try { observed = await this.disk(source.disk.source); }
    catch (error) {
      if ((error as { response?: { status?: number } }).response?.status !== 404) throw error;
      return null;
    }
    if (observed.id !== source.disk.id) throw new Error("retained home identity changed before cleanup");
    if (observed.ownerUid !== uid.toLowerCase()) throw new Error("retained home owner changed before cleanup");
    return observed;
  }
  async detachForRemoval(uid: string, source: BuilderHomeLocation, observed: ObservedHomeDisk): Promise<void> {
    const computer = await this.stoppedOwnedComputer(uid);
    if (!computer || !source.computer || computer.instanceId !== source.computer.id || observed.users!.length !== 1 || !observed.users![0].endsWith(`/zones/${computer.zone}/instances/${computer.name}`)) throw new Error("retained home is attached to an unverified computer");
    const url = `${this.base}/zones/${computer.zone}/instances/${computer.name}`;
    const instance = await this.compute(url, "GET");
    const attached = instance.disks?.find(entry => entry.deviceName === "octogee-home" && !entry.boot);
    if (instance.id !== computer.instanceId || !attached || attached.autoDelete !== false || (await this.disk(attached.source)).id !== source.disk.id) throw new Error("retained home attachment changed before cleanup");
    await this.deps.journal("detach-expired-builder-home", uid, () => this.compute(`${url}/detachDisk?deviceName=octogee-home`, "POST"));
  }
  async remainingOwnerHomes(uid: string): Promise<string[]> {
    const filter = encodeURIComponent(`labels.octogee-owner-uid="${uid.toLowerCase()}"`);
    const aggregated = await this.compute(`${this.base}/aggregated/disks?filter=${filter}`, "GET");
    const disks = Object.values(aggregated.items ?? {}).flatMap(scope => scope.disks ?? [])
      .map(disk => (disk.selfLink ?? disk.name ?? "").replace(/^https:\/\/(?:www|compute)\.googleapis\.com\/compute\/v1\//u, ""));
    return disks;
  }
  async removeStoppedHome(uid: string, source: BuilderHomeLocation): Promise<boolean> {
    assertNativeHome(source);
    const observed = await this.observedForRemoval(uid, source);
    if (!observed) return true;
    if (observed.users?.length) await this.detachForRemoval(uid, source, observed);
    else await this.deps.journal("remove-retained-builder-home", uid, () => this.compute(`${this.base}/zones/${observed.zone}/disks/${observed.name}`, "DELETE"));
    return false;
  }
}

export function createBuilderHomeProvider(deps: HomeProviderDeps): Pick<BuilderHomeMigrationDeps, "inventory" | "verifyStopped" | "adopt" | "nativeZone" | "removeStoppedHome"> & { remainingOwnerHomes(uid: string): Promise<string[]> } {
  const provider = new BuilderHomeProvider(deps);
  return {
    inventory: provider.inventory.bind(provider), verifyStopped: provider.verifyStopped.bind(provider),
    adopt: provider.adopt.bind(provider), removeStoppedHome: provider.removeStoppedHome.bind(provider),
    remainingOwnerHomes: provider.remainingOwnerHomes.bind(provider),
    nativeZone: async uid => (await provider.ownedComputer(uid, PARKED_STATUSES))?.zone ?? null,
  };
}
