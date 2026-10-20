import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { BuilderHomeLocation, BuilderHomeMigration, BuilderHomeOwner } from "../builder-home-migration.js";
import type { HomeCopyInput } from "./compute-home-copy.js";

export async function eraseBuilderHomeMigrationStorage(deps: {
  db: Firestore;
  removeStoppedHome(uid: string, home: BuilderHomeLocation): Promise<boolean>;
  copy: { abort(input: HomeCopyInput): Promise<boolean>; sweep(input: HomeCopyInput): Promise<boolean> };
  remainingOwnerHomes(uid: string): Promise<string[]>;
  log(message: string): void;
}, uid: string): Promise<boolean> {
  const ref = deps.db.collection("users").doc(uid);
  const owner = (await ref.get()).data() as BuilderHomeOwner & { provisioning?: { homeErasure?: BuilderHomeLocation[] } } | undefined;
  if (!owner) {
    const remaining = await deps.remainingOwnerHomes(uid);
    if (remaining.length) throw new Error(`home erasure owner record is missing while home storage remains: ${remaining.join(", ")}`);
    deps.log(`[home-erasure] ${uid}: owner record already erased and no owner-labelled home storage remains`);
    return true;
  }
  const provisioning = owner.provisioning ?? {};
  const migration = provisioning.homeMigration as BuilderHomeMigration | undefined;
  if (migration?.copy) {
    const adopted = ["adopting", "complete"].includes(migration.phase);
    if (!await (adopted ? deps.copy.sweep(migration.copy) : deps.copy.abort(migration.copy))) return false;
  }
  let queue = provisioning.homeErasure as BuilderHomeLocation[] | undefined;
  if (!queue) {
    queue = homeErasureQueue(provisioning, migration);
    if (!queue.length) return true;
    await ref.update({ "provisioning.homeErasure": queue });
  }
  if (queue.length) {
    if (!await deps.removeStoppedHome(uid, queue[0])) return false;
    const removed = queue[0].disk.id;
    await deps.db.runTransaction(async tx => {
      const current = (await tx.get(ref)).data()?.provisioning?.homeErasure;
      if (!Array.isArray(current) || current[0]?.disk?.id !== removed) throw new Error("home erasure queue changed");
      tx.update(ref, { "provisioning.homeErasure": current.slice(1) });
    });
    return false;
  }
  await ref.update({ "provisioning.homeStorage": FieldValue.delete(), "provisioning.homeMigration": FieldValue.delete(),
    "provisioning.homeErasure": FieldValue.delete(), "provisioning.homeCapacity": FieldValue.delete() });
  return true;
}

function homeErasureQueue(provisioning: NonNullable<BuilderHomeOwner["provisioning"]>, migration?: BuilderHomeMigration): BuilderHomeLocation[] {
    const homes: BuilderHomeLocation[] = [...(provisioning.homeStorage?.retained ?? [])];
    if (provisioning.homeStorage?.disk) homes.push(provisioning.homeStorage);
    if (migration?.source) homes.push(migration.source);
    if (migration?.target && ["adopting", "complete"].includes(migration.phase)) homes.push({ runtime: "gce-vm", layout: "portable", disk: migration.target });
    const unique = new Map<string, BuilderHomeLocation>();
    for (const home of homes) if (!unique.has(home.disk.id)) unique.set(home.disk.id, home);
    return [...unique.values()];
}
