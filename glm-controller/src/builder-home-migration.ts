import { createHash } from "node:crypto";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { withCurrentBuilderTier, type BuilderTierReader } from "@octogee/core/builder-activation-lease";
import type {
  BuilderHomeState,
  BuilderRecord,
  OpaqueMap,
  PlatformStateStore,
  RecordPatch,
  Stored,
  GatewayComputerProfile,
} from "@octogee/core/platform-state";
import type { AllocateDisposableGatewayInput } from "./placement-policy-reconciler.js";
import { HomeCopyFailure, homeCopyCapacity, type CopyHomeDisk, type HomeCopyInput, type HomeCopyProgress } from "./lib/compute-home-copy.js";

export interface BuilderHomeLocation {
  runtime: "gce-vm";
  disk: CopyHomeDisk;
  layout: "flat" | "portable";
  computer?: { name: string; id: string; zone: string };
}
export interface BuilderHomeMigration {
  id: string;
  tier: string;
  source: BuilderHomeLocation;
  copy: HomeCopyInput;
  phase: "copying" | "retaining" | "releasing" | "adopting" | "complete" | "failed" | "retrying" | "blocked";
  attempt?: number;
  retryAt?: number;
  error?: string;
  target?: CopyHomeDisk;
  proof?: Extract<HomeCopyProgress, { status: "ready" }>;
  startedAt: number;
  completedAt?: number;
}
export interface BuilderHomeStorage extends BuilderHomeLocation {
  retained: BuilderHomeLocation[];
  admittedAt?: number;
}
export interface BuilderHomeOwner {
  computer?: { instanceName: string; instanceId: string; zone: string };
  homeStorage?: BuilderHomeStorage;
  homeMigration?: BuilderHomeMigration;
  homeDisk?: CopyHomeDisk;
}
export function builderHomeOwner(builder: BuilderRecord): BuilderHomeOwner {
  return builder.home as BuilderHomeOwner;
}
export interface BuilderHomeMigrationDeps {
  store: PlatformStateStore;
  readBuilderTier: BuilderTierReader;
  environment: "test" | "prod";
  now: () => number;
  subnetwork: string;
  nativeZones: readonly string[];
  nativeZone: (uid: string) => Promise<string | null>;
  inventory: (uid: string, owner: BuilderHomeOwner) => Promise<BuilderHomeLocation | null>;
  verifyStopped: (uid: string, source: BuilderHomeLocation) => Promise<void>;
  copy: {
    advance(input: HomeCopyInput): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }>;
    release(input: HomeCopyInput): Promise<boolean>;
    abort(input: HomeCopyInput): Promise<boolean>;
  };
  adopt: (input: { uid: string; target: CopyHomeDisk }) => Promise<boolean>;
  removeStoppedHome: (uid: string, source: BuilderHomeLocation) => Promise<boolean>;
  log: (message: string) => void;
}

export function assertHomeMigrationAuthority(owner: BuilderRecord, tier: string | null, request: AllocateDisposableGatewayInput): void {
  const lease = owner.activationLease;
  if (!accountAllowsInteractiveAccess({ accountLifecycle: owner.accountLifecycle ?? undefined }) || tier !== request.entitlementTier ||
      owner.gateway?.gatewayId !== request.sourceGatewayId || lease?.leaseId !== request.leaseId || lease.generation !== request.generation ||
      lease.status !== "requested" || lease.targetGatewayId !== undefined || lease.sourceAssignmentEpoch !== request.sourceAssignmentEpoch ||
      lease.entitlementTier !== request.entitlementTier || lease.sizingTier !== request.sizingTier) throw new Error("home migration activation authority changed");
}

type HomePatch = RecordPatch<BuilderHomeState>;

function stored(value: object): OpaqueMap {
  return value as OpaqueMap;
}

function assertNativeCopy(state: BuilderHomeMigration): void {
  const legacy = state as { copy: { targetFilesystem?: string }; target?: { claim?: unknown }; proof?: { filesystem?: string } };
  if (legacy.copy.targetFilesystem === "ext4" || legacy.target?.claim !== undefined || legacy.proof?.filesystem !== "btrfs") {
    throw new Error("home migration targets a cluster home; retired cluster home records need operator cleanup");
  }
}

class HomeMigration {
  constructor(private readonly deps: BuilderHomeMigrationDeps, private readonly request: AllocateDisposableGatewayInput) {}

  private computerPolicy: GatewayComputerProfile | null = null;
  private get policy(): GatewayComputerProfile {
    if (!this.computerPolicy) throw new Error("home migration requires a computer tier policy");
    return this.computerPolicy;
  }
  private async loadPolicy(): Promise<void> {
    const profile = await this.deps.store.config.orchestrator.getSizingProfile(this.request.entitlementTier);
    if (profile.isolation !== "isolated") throw new Error("home migration requires a computer tier policy");
    this.computerPolicy = profile.computer;
  }
  private withCurrentTier<T>(run: (assertOwner: (owner: Stored<BuilderRecord> | null) => Stored<BuilderRecord>) => Promise<T>): Promise<T> {
    return withCurrentBuilderTier({ store: this.deps.store, readBuilderTier: this.deps.readBuilderTier, uid: this.request.uid, now: this.deps.now() },
      ({ tier, assertCurrent }) => run((owner) => {
        assertCurrent(owner);
        if (!owner) throw new Error("home migration owner disappeared");
        assertHomeMigrationAuthority(owner, tier, this.request);
        return owner;
      }));
  }
  private async readOwner(): Promise<Stored<BuilderRecord>> {
    return this.withCurrentTier(async assertOwner => assertOwner(await this.deps.store.builders.records.get(this.request.uid)));
  }
  private async transaction(label: string, update: (owner: BuilderHomeOwner) => HomePatch): Promise<void> {
    await this.withCurrentTier(assertOwner => this.deps.store.transaction({ label: `builder-home-migration.${label}` }, async tx => {
      const owner = assertOwner(await tx.builders.records.get(this.request.uid));
      await tx.builders.records.patch(this.request.uid, { home: update(builderHomeOwner(owner)) }, { revision: owner.revision });
    }));
  }
  private async save(state: BuilderHomeMigration, home: HomePatch = {}): Promise<void> {
    await this.transaction("save", owner => {
      if (owner.homeMigration?.id !== state.id) throw new Error("home migration operation changed");
      return { ...home, homeMigration: stored(state) };
    });
  }
  private async removeExpiredHome(storage?: BuilderHomeStorage): Promise<void> {
    if (!storage || !Number.isSafeInteger(storage.admittedAt) || this.deps.now() - storage.admittedAt! < 7 * 24 * 60 * 60_000) return;
    const previous = storage.retained[0];
    if (!previous) return;
    if (previous.disk.id === storage.disk.id) throw new Error("retained home cleanup cannot remove the primary home");
    if (!await this.deps.removeStoppedHome(this.request.uid, previous)) return;
    await this.transaction("remove-expired-home", owner => {
      const home = owner.homeStorage;
      if (home?.disk.id !== storage.disk.id || home.retained[0]?.disk.id !== previous.disk.id) throw new Error("retained home cleanup authority changed");
      return { homeStorage: stored({ ...home, retained: home.retained.slice(1) }) };
    });
  }
  private async targetZone(source: BuilderHomeLocation): Promise<string> {
    const existing = await this.deps.nativeZone(this.request.uid);
    if (existing) return existing;
    const selected = this.deps.nativeZones.includes(source.disk.zone) ? source.disk.zone : this.deps.nativeZones[0];
    if (!selected) throw new Error("home migration has no native target zone");
    return selected;
  }
  private async start(source: BuilderHomeLocation): Promise<BuilderHomeMigration> {
    await this.deps.verifyStopped(this.request.uid, source);
    const key = [this.request.uid, source.disk.id, this.request.leaseId, this.request.generation, this.request.entitlementTier].join(":");
    const id = `home-copy-${this.deps.environment}-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const state: BuilderHomeMigration = { id, tier: this.request.entitlementTier, source, startedAt: this.deps.now(), phase: "copying", attempt: 1, copy: {
      operationId: id, ownerUid: this.request.uid, source: source.disk, sourceLayout: source.layout,
      targetZone: await this.targetZone(source),
      desiredGiB: this.policy.homeSizeGiB, subnetwork: this.deps.subnetwork,
    } };
    await this.transaction("start", owner => {
      const previous = owner.homeMigration;
      if (previous && previous.phase !== "complete" && previous.id !== id) throw new Error("another home migration is in progress");
      return { homeMigration: stored(state) };
    });
    return state;
  }
  private alreadyFits(state: BuilderHomeMigration | undefined, source: BuilderHomeLocation): boolean {
    if (state && state.phase !== "complete") return false;
    if (source.disk.sizeGb <= this.policy.homeSizeGiB) return true;
    return state?.target?.id === source.disk.id && this.deps.now() - (state.completedAt ?? 0) < 24 * 60 * 60_000;
  }
  private async cancel(state: BuilderHomeMigration): Promise<void> {
    if (!await this.deps.copy.abort(state.copy)) return;
    await this.transaction("cancel", owner => {
      if (owner.homeMigration?.id !== state.id) throw new Error("home migration changed during cancellation");
      return { homeMigration: { clear: true } };
    });
  }
  private async failed(state: BuilderHomeMigration): Promise<void> {
    if (!await this.deps.copy.abort(state.copy)) return;
    await this.save({ ...state, phase: (state.attempt ?? 1) >= 3 ? "blocked" : "retrying", retryAt: this.deps.now() + 60_000 });
  }
  private async retry(state: BuilderHomeMigration, source: BuilderHomeLocation): Promise<boolean> {
    if (this.deps.now() < (state.retryAt ?? 0)) return false;
    const next = { ...state, phase: "copying" as const, attempt: (state.attempt ?? 1) + 1 };
    await this.save(next);
    return this.copy(next, source);
  }
  private retainLargerHome(progress: HomeCopyProgress, source: BuilderHomeLocation): boolean {
    return progress.status !== "pending" && homeCopyCapacity({
      desiredGiB: this.policy.homeSizeGiB, sourceGiB: source.disk.sizeGb, usedBytes: progress.usedBytes,
    }) >= source.disk.sizeGb;
  }
  private async copy(state: BuilderHomeMigration, source: BuilderHomeLocation): Promise<boolean> {
    await this.deps.verifyStopped(this.request.uid, state.source);
    let result: Awaited<ReturnType<BuilderHomeMigrationDeps["copy"]["advance"]>>;
    try { result = await this.deps.copy.advance(state.copy); }
    catch (error) {
      if (!(error instanceof HomeCopyFailure)) throw error;
      await this.save({ ...state, phase: "failed", error: error.message });
      this.deps.log(`[home-migration] ${this.request.uid}: ${error.message}; cleaning failed copy resources before retry`);
      return false;
    }
    if (this.retainLargerHome(result.progress, source)) await this.save({ ...state, phase: "retaining" });
    else if (result.progress.status === "ready" && result.target) await this.save({ ...state, phase: "releasing", target: result.target, proof: result.progress });
    return false;
  }
  private async retain(state: BuilderHomeMigration, source: BuilderHomeLocation): Promise<boolean> {
    if (!await this.deps.copy.abort(state.copy)) return false;
    await this.save({ ...state, phase: "complete", target: source.disk, completedAt: this.deps.now() }, {
      homeCapacity: { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: source.disk.sizeGb, status: "shrink-pending", diskId: source.disk.id },
    });
    return true;
  }
  private async release(state: BuilderHomeMigration): Promise<boolean> {
    if (await this.deps.copy.release(state.copy)) await this.save({ ...state, phase: "adopting" });
    return false;
  }
  private async adopt(state: BuilderHomeMigration): Promise<boolean> {
    const { target, proof } = state;
    if (!target || !proof) throw new Error("home migration has no verified target");
    assertNativeCopy(state);
    await this.readOwner();
    if (!await this.deps.adopt({ uid: this.request.uid, target })) return false;
    const homeCapacity = { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: target.sizeGb, usedBytes: proof.usedBytes,
      status: target.sizeGb > this.policy.homeSizeGiB ? "shrink-pending" : "ready", diskId: target.id };
    await this.transaction("adopt", owner => {
      if (owner.homeMigration?.id !== state.id) throw new Error("home migration operation changed before activation");
      return {
        homeCapacity,
        homeDisk: stored(target),
        homeMigration: stored({ ...state, phase: "complete", completedAt: this.deps.now() }),
        homeStorage: stored({ runtime: "gce-vm", disk: target, layout: "portable", retained: [...(owner.homeStorage?.retained ?? []), state.source] }),
      };
    });
    this.deps.log(`[home-migration] ${this.request.uid}: verified native home ${target.id} (${target.sizeGb} GiB); previous home retained`);
    return true;
  }
  async reconcile(): Promise<boolean> {
    await this.loadPolicy();
    const owner = builderHomeOwner(await this.readOwner());
    await this.removeExpiredHome(owner.homeStorage);
    const source = await this.deps.inventory(this.request.uid, owner);
    if (!source) return true;
    let state = owner.homeMigration;
    if (this.alreadyFits(state, source)) return true;
    if (!state || state.phase === "complete") state = await this.start(source);
    if (state.source.disk.id !== source.disk.id && state.phase !== "adopting") throw new Error("home migration source changed; original disks retained");
    if (state.tier !== this.request.entitlementTier && state.phase !== "adopting") {
      await this.cancel(state);
      return false;
    }
    return this.advance(state, source);
  }
  private async advance(state: BuilderHomeMigration, source: BuilderHomeLocation): Promise<boolean> {
    switch (state.phase) {
      case "failed": await this.failed(state); return false;
      case "blocked": throw new Error(`home migration requires operator repair after three failed copies; original retained: ${state.error}`);
      case "retrying": return this.retry(state, source);
      case "copying": return this.copy(state, source);
      case "retaining": return this.retain(state, source);
      case "releasing": return this.release(state);
      case "adopting": return this.adopt(state);
      default: throw new Error("invalid home migration phase");
    }
  }
}

export function createBuilderHomeMigrator(deps: BuilderHomeMigrationDeps) {
  return (request: AllocateDisposableGatewayInput): Promise<boolean> => new HomeMigration(deps, request).reconcile();
}
