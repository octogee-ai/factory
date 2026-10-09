import type { Firestore } from "firebase-admin/firestore";
import type { GatewayVmSpec, RetainedBuilderHome } from "@octogee/shared/types/glm";
import type { ComputeImageRef, GatewayVmClient } from "./compute-vm.js";

export interface RetainedBootImage extends ComputeImageRef {
  project: string;
  homeId: string;
  previous: { name: string; id: string } | null;
  operationId: string | null;
  sourceComputer: { name: string; zone: string; instanceId: string; gatewayId: string } | null;
}
const imageName = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;

async function verifyPinnedBootImage(vm: GatewayVmClient, home: RetainedBuilderHome, prior: RetainedBootImage): Promise<void> {
  if (!prior || prior.homeId !== home.id || !imageName.test(prior.name) || !/^[1-9]\d{0,19}$/u.test(prior.id)
    || !imageName.test(prior.project)) throw new Error("retained boot image anchor is malformed");
  const observed = await vm.readImage(prior.name, prior.project);
  if (observed.id !== prior.id || observed.name !== prior.name || !observed.homeAdmission) throw new Error("pinned retained boot image identity or admission contract changed");
}

function assertPinnedSource(prior: RetainedBootImage, previous: ComputeImageRef, source: RetainedBootImage["sourceComputer"] | undefined): void {
  if (!prior.sourceComputer || !source || ["instanceId", "name", "zone", "gatewayId"].some(key => prior.sourceComputer![key as keyof typeof source] !== source[key as keyof typeof source])
    || prior.previous?.id !== previous.id || prior.previous?.name !== previous.name) throw new Error("retained boot operation source changed");
}

export async function selectRetainedBootImage(input: { db: Firestore; vm: GatewayVmClient; ownerUid: string;
  home: RetainedBuilderHome; spec: GatewayVmSpec; previous?: ComputeImageRef; operationId?: string; sourceComputer?: RetainedBootImage["sourceComputer"] }): Promise<RetainedBootImage> {
  const { db, vm, ownerUid, home, spec, previous } = input;
  const owner = db.collection("users").doc(ownerUid);
  const prior = (await owner.get()).data()?.provisioning?.homeDisk?.bootImage as RetainedBootImage | undefined;
  let selected: RetainedBootImage;
  if (prior !== undefined && (!previous || prior?.operationId === input.operationId)) {
    await verifyPinnedBootImage(vm, home, prior);
    if (previous) assertPinnedSource(prior, previous, input.sourceComputer);
    selected = prior;
  } else {
    const project = spec.imageProject ?? home.projectId;
    const image = await vm.readFamilyImage(spec.imageFamily, project);
    if (!image.homeAdmission) throw new Error("replacement boot requires qualified current-SSH authority and native home migration admission");
    selected = { ...image, project, homeId: home.id, previous: previous ? { name: previous.name, id: previous.id } : null, operationId: input.operationId ?? null, sourceComputer: input.sourceComputer ?? null };
    await db.runTransaction(async tx => {
      const fresh = await tx.get(owner);
      const current = fresh.data()?.provisioning?.homeDisk;
      if (!fresh.exists || current?.id !== home.id || current.source !== home.source) throw new Error("retained home owner/anchor changed before image selection");
      const currentImage = current.bootImage;
      if (currentImage?.id !== prior?.id || currentImage?.operationId !== prior?.operationId) throw new Error("retained boot selection changed concurrently");
      tx.set(owner, { provisioning: { homeDisk: { bootImage: selected } } }, { merge: true });
    });
  }
  return selected;
}
