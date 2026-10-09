import { createHash } from "node:crypto";
import { FieldValue, type Firestore, type Transaction } from "firebase-admin/firestore";
import { BUILDER_TIERS } from "@octogee/shared/types/billing-tiers";
import { resolveBuilderTier, type TierResolvable } from "@octogee/shared/types/billing";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import type { AllocateDisposableGatewayInput } from "./placement-policy-reconciler.js";
import { HomeCopyFailure, homeCopyCapacity, type CopyHomeDisk, type HomeCopyInput, type HomeCopyProgress } from "./lib/compute-home-copy.js";

export interface BuilderHomeLocation {
  runtime: "cluster" | "gce-vm";
  disk: CopyHomeDisk;
  layout: "flat" | "portable";
  claim?: { name: string; uid: string; volumeName: string };
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
export interface BuilderHomeOwner extends Record<string, unknown>, TierResolvable {
  provisioning?: {
    homeStorage?: BuilderHomeStorage;
    homeMigration?: BuilderHomeMigration;
    homeDisk?: CopyHomeDisk;
    openclaw?: {
      gatewayId?: string;
      activationLease?: Partial<AllocateDisposableGatewayInput> & { status?: string; targetGatewayId?: string };
    };
  };
}
export interface BuilderHomeMigrationDeps {
  db: Firestore;
  now: () => number;
  subnetwork: string;
  nativeZones: readonly string[];
  nativeZone: (uid: string) => Promise<string | null>;
  inventory: (uid: string, slug: string, owner: BuilderHomeOwner) => Promise<BuilderHomeLocation | null>;
  verifyStopped: (uid: string, source: BuilderHomeLocation) => Promise<void>;
  copy: {
    advance(input: HomeCopyInput): Promise<{ progress: HomeCopyProgress; target?: CopyHomeDisk }>;
    release(input: HomeCopyInput): Promise<boolean>;
    abort(input: HomeCopyInput): Promise<boolean>;
  };
  adopt: (input: { uid: string; slug: string; source: BuilderHomeLocation; target: CopyHomeDisk; runtime: "cluster" | "gce-vm"; operationId: string }) => Promise<boolean>;
  removeStoppedHome: (uid: string, source: BuilderHomeLocation) => Promise<boolean>;
  log: (message: string) => void;
}

export function assertHomeMigrationAuthority(owner: BuilderHomeOwner, request: AllocateDisposableGatewayInput, now: number): void {
  const openclaw = owner.provisioning?.openclaw;
  const lease = openclaw?.activationLease;
  if (!accountAllowsInteractiveAccess(owner) || resolveBuilderTier(owner, new Date(now)) !== request.entitlementTier ||
      openclaw?.gatewayId !== request.sourceGatewayId || lease?.leaseId !== request.leaseId || lease.generation !== request.generation ||
      lease.status !== "requested" || lease.targetGatewayId !== undefined || lease.sourceAssignmentEpoch !== request.sourceAssignmentEpoch ||
      lease.entitlementTier !== request.entitlementTier || lease.sizingTier !== request.sizingTier) throw new Error("home migration activation authority changed");
}

class HomeMigration {
  constructor(private readonly deps: BuilderHomeMigrationDeps, private readonly request: AllocateDisposableGatewayInput) {}

  private get ownerRef() { return this.deps.db.collection("users").doc(this.request.uid); }
  private get policy() {
    const policy = BUILDER_TIERS[this.request.entitlementTier].computer;
    if (!policy) throw new Error("home migration requires a computer tier policy");
    return policy;
  }
  private assertOwner(owner: BuilderHomeOwner): void { assertHomeMigrationAuthority(owner, this.request, this.deps.now()); }
  private async readOwner(): Promise<BuilderHomeOwner> {
    const snapshot = await this.ownerRef.get();
    if (!snapshot.exists) throw new Error("home migration owner disappeared");
    const owner = snapshot.data() as BuilderHomeOwner;
    this.assertOwner(owner);
    return owner;
  }
  private async transaction(update: (owner: BuilderHomeOwner, tx: Transaction) => void): Promise<void> {
    await this.deps.db.runTransaction(async tx => {
      const owner = (await tx.get(this.ownerRef)).data() as BuilderHomeOwner;
      if (!owner) throw new Error("home migration owner disappeared");
      this.assertOwner(owner);
      update(owner, tx);
    });
  }
  private async save(state: BuilderHomeMigration, fields: Record<string, unknown> = {}): Promise<void> {
    await this.transaction((owner, tx) => {
      if (owner.provisioning?.homeMigration?.id !== state.id) throw new Error("home migration operation changed");
      tx.update(this.ownerRef, { ...fields, "provisioning.homeMigration": state });
    });
  }
  private async removeExpiredHome(storage?: BuilderHomeStorage): Promise<void> {
    if (!storage || !Number.isSafeInteger(storage.admittedAt) || this.deps.now() - storage.admittedAt! < 7 * 24 * 60 * 60_000) return;
    const previous = storage.retained[0];
    if (!previous) return;
    if (previous.disk.id === storage.disk.id) throw new Error("retained home cleanup cannot remove the primary home");
    if (!await this.deps.removeStoppedHome(this.request.uid, previous)) return;
    await this.transaction((owner, tx) => {
      const home = owner.provisioning?.homeStorage;
      if (home?.disk.id !== storage.disk.id || home.retained[0]?.disk.id !== previous.disk.id) throw new Error("retained home cleanup authority changed");
      tx.update(this.ownerRef, { "provisioning.homeStorage.retained": home.retained.slice(1) });
    });
  }
  private async targetZone(source: BuilderHomeLocation): Promise<string> {
    if (this.policy.runtime === "cluster") return source.disk.zone;
    const existing = await this.deps.nativeZone(this.request.uid);
    if (existing) return existing;
    const selected = this.deps.nativeZones.includes(source.disk.zone) ? source.disk.zone : this.deps.nativeZones[0];
    if (!selected) throw new Error("home migration has no native target zone");
    return selected;
  }
  private async start(source: BuilderHomeLocation): Promise<BuilderHomeMigration> {
    await this.deps.verifyStopped(this.request.uid, source);
    const key = [this.request.uid, source.disk.id, this.request.leaseId, this.request.generation, this.request.entitlementTier].join(":");
    const id = `home-copy-${createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const state: BuilderHomeMigration = { id, tier: this.request.entitlementTier, source, startedAt: this.deps.now(), phase: "copying", attempt: 1, copy: {
      operationId: id, ownerUid: this.request.uid, source: source.disk, sourceLayout: source.layout,
      targetZone: await this.targetZone(source), targetFilesystem: this.policy.runtime === "cluster" ? "ext4" : "btrfs",
      desiredGiB: this.policy.homeSizeGiB, subnetwork: this.deps.subnetwork,
    } };
    await this.transaction((owner, tx) => {
      const previous = owner.provisioning?.homeMigration;
      if (previous && previous.phase !== "complete" && previous.id !== id) throw new Error("another home migration is in progress");
      tx.update(this.ownerRef, { "provisioning.homeMigration": state });
    });
    return state;
  }
  private alreadyFits(state: BuilderHomeMigration | undefined, source: BuilderHomeLocation): boolean {
    if (state && state.phase !== "complete") return false;
    if (source.runtime !== this.policy.runtime) return false;
    if (source.disk.sizeGb <= this.policy.homeSizeGiB) return true;
    return state?.target?.id === source.disk.id && this.deps.now() - (state.completedAt ?? 0) < 24 * 60 * 60_000;
  }
  private async cancel(state: BuilderHomeMigration): Promise<void> {
    if (!await this.deps.copy.abort(state.copy)) return;
    await this.transaction((owner, tx) => {
      if (owner.provisioning?.homeMigration?.id !== state.id) throw new Error("home migration changed during cancellation");
      tx.update(this.ownerRef, { "provisioning.homeMigration": FieldValue.delete() });
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
    return progress.status !== "pending" && source.runtime === this.policy.runtime && homeCopyCapacity({
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
      "provisioning.homeCapacity": { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: source.disk.sizeGb, status: "shrink-pending", diskId: source.disk.id },
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
    await this.readOwner();
    const runtime = state.copy.targetFilesystem === "ext4" ? "cluster" : "gce-vm";
    if (!await this.deps.adopt({ uid: this.request.uid, slug: this.request.builderSlug, source: state.source, target, runtime, operationId: state.id })) return false;
    const fields = {
      "provisioning.homeCapacity": { desiredGiB: this.policy.homeSizeGiB, allocatedGiB: target.sizeGb, usedBytes: proof.usedBytes,
        status: target.sizeGb > this.policy.homeSizeGiB ? "shrink-pending" : "ready", diskId: target.id },
      ...(runtime === "gce-vm" ? { "provisioning.homeDisk": target } : {}),
    };
    await this.transaction((owner, tx) => {
      if (owner.provisioning?.homeMigration?.id !== state.id) throw new Error("home migration operation changed before activation");
      tx.update(this.ownerRef, { ...fields,
        "provisioning.homeMigration": { ...state, phase: "complete", completedAt: this.deps.now() },
        "provisioning.homeStorage": { runtime, disk: target, ...(target.claim ? { claim: target.claim } : {}), layout: "portable", retained: [...(owner.provisioning.homeStorage?.retained ?? []), state.source] },
      });
    });
    this.deps.log(`[home-migration] ${this.request.uid}: verified ${runtime} home ${target.id} (${target.sizeGb} GiB); previous home retained`);
    return runtime === this.policy.runtime;
  }
  async reconcile(): Promise<boolean> {
    const owner = await this.readOwner();
    await this.removeExpiredHome(owner.provisioning?.homeStorage);
    const source = await this.deps.inventory(this.request.uid, this.request.builderSlug, owner);
    if (!source) return true;
    let state = owner.provisioning?.homeMigration;
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
