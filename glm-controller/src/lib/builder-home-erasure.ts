import type { BuilderHomeState, OpaqueMap, PlatformStateStore } from "@octogee/core/platform-state";
import type { BuilderHomeLocation, BuilderHomeMigration, BuilderHomeStorage } from "../builder-home-migration.js";
import type { HomeCopyInput } from "./compute-home-copy.js";

export async function eraseBuilderHomeMigrationStorage(deps: {
  store: PlatformStateStore;
  removeStoppedHome(uid: string, home: BuilderHomeLocation): Promise<boolean>;
  copy: { abort(input: HomeCopyInput): Promise<boolean>; sweep(input: HomeCopyInput): Promise<boolean> };
  remainingOwnerHomes(uid: string): Promise<string[]>;
  log(message: string): void;
}, uid: string): Promise<boolean> {
  const owner = await deps.store.builders.records.get(uid);
  if (!owner) {
    const remaining = await deps.remainingOwnerHomes(uid);
    if (remaining.length) throw new Error(`home erasure owner record is missing while home storage remains: ${remaining.join(", ")}`);
    deps.log(`[home-erasure] ${uid}: owner record already erased and no owner-labelled home storage remains`);
    return true;
  }
  const migration = owner.home.homeMigration as BuilderHomeMigration | undefined;
  if (migration?.copy) {
    const adopted = ["adopting", "complete"].includes(migration.phase);
    if (!await (adopted ? deps.copy.sweep(migration.copy) : deps.copy.abort(migration.copy))) return false;
  }
  let queue = owner.home.homeErasure as readonly BuilderHomeLocation[] | undefined;
  if (!queue) {
    queue = homeErasureQueue(owner.home, migration);
    if (!queue.length) return true;
    await deps.store.builders.records.patch(uid, { home: { homeErasure: storedQueue(queue) } });
  }
  if (queue.length) {
    if (!await deps.removeStoppedHome(uid, queue[0])) return false;
    const removed = queue[0].disk.id;
    await deps.store.transaction({ label: "builder-home-erasure.dequeue" }, async tx => {
      const current = await tx.builders.records.get(uid);
      const erasure = current?.home.homeErasure as readonly BuilderHomeLocation[] | undefined;
      if (!current || !erasure || erasure[0]?.disk?.id !== removed) throw new Error("home erasure queue changed");
      await tx.builders.records.patch(uid, { home: { homeErasure: storedQueue(erasure.slice(1)) } }, { revision: current.revision });
    });
    return false;
  }
  await deps.store.builders.records.patch(uid, { home: {
    homeStorage: { clear: true }, homeMigration: { clear: true }, homeErasure: { clear: true }, homeCapacity: { clear: true },
  } });
  return true;
}

function storedQueue(homes: readonly BuilderHomeLocation[]): readonly OpaqueMap[] {
  return homes as unknown as readonly OpaqueMap[];
}

function homeErasureQueue(home: BuilderHomeState, migration?: BuilderHomeMigration): BuilderHomeLocation[] {
    const storage = home.homeStorage as BuilderHomeStorage | undefined;
    const homes: BuilderHomeLocation[] = [...(storage?.retained ?? [])];
    if (storage?.disk) homes.push(storage);
    if (migration?.source) homes.push(migration.source);
    if (migration?.target && ["adopting", "complete"].includes(migration.phase)) homes.push({ runtime: "gce-vm", layout: "portable", disk: migration.target });
    const unique = new Map<string, BuilderHomeLocation>();
    for (const home of homes) if (!unique.has(home.disk.id)) unique.set(home.disk.id, home);
    return [...unique.values()];
}
