import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import { assertBuilderRuntimeStorage } from "../builder-runtime-storage.js";

function fixture(runtime: "cluster" | "gce-vm") {
  const disk = { id: "42", source: "projects/test/zones/us-central1-a/disks/home" };
  const provisioning: Record<string, unknown> = { homeStorage: { runtime, disk, claim: {name:"home-copy-second-home",uid:"claim-1",volumeName:"home-1"} }, homeDisk: disk };
  const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ provisioning }) }) }) }) } as unknown as Firestore;
  const claim = { metadata: { name: "home-copy-second-home", uid: "claim-1", annotations: { "octogee.ai/owner-uid": "owner" } }, spec: { volumeName: "home-1", accessModes:["ReadWriteOncePod"] }, status:{phase:"Bound"} };
  const pv = { metadata: { name: "home-1" }, spec: { claimRef: { uid: "claim-1", name:"home-copy-second-home", namespace:"test" }, csi: { driver:"pd.csi.storage.gke.io", volumeHandle: disk.source } } };
  const runKubectl = vi.fn(async (args: string[]) => ({ code: 0, stderr: "", stdout: JSON.stringify(args.includes("pv") ? pv : claim) }));
  const input = { db, runtime, ownerUid: "owner", builderSlug: "alice", namespace: "test", runKubectl };
  return { input, provisioning, disk, claim, pv, runKubectl };
}

describe("adopted Builder runtime storage", () => {
  it("admits the recorded native home and refuses a substituted disk", async () => {
    const h = fixture("gce-vm");
    await expect(assertBuilderRuntimeStorage(h.input)).resolves.toBeUndefined();
    h.provisioning.homeDisk = { ...h.disk, id: "43" };
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/native home differs/);
    expect(h.runKubectl).not.toHaveBeenCalled();
  });
  it("admits the exact migrated claim and CSI disk", async () => {
    const h = fixture("cluster");
    await expect(assertBuilderRuntimeStorage(h.input)).resolves.toBeUndefined();
    expect(h.runKubectl).toHaveBeenCalledTimes(2);
    expect(h.runKubectl.mock.calls[0][0]).toContain("home-copy-second-home");
  });
  it.each(["owner", "claim", "namespace", "source"])("refuses changed %s identity", async change => {
    const h = fixture("cluster");
    if (change === "owner") h.claim.metadata.annotations["octogee.ai/owner-uid"] = "other";
    if (change === "claim") h.pv.spec.claimRef.uid = "claim-2";
    if (change === "namespace") h.pv.spec.claimRef.namespace = "prod";
    if (change === "source") h.pv.spec.csi.volumeHandle = "another-disk";
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/differs/);
  });
  it("refuses an unmigrated native home on Hobby", async () => {
    const h = fixture("cluster");
    delete h.provisioning.homeStorage;
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/explicit storage migration/);
  });
  it("refuses an unmigrated Hobby claim on native", async () => {
    const h = fixture("gce-vm");
    delete h.provisioning.homeStorage;
    delete h.provisioning.homeDisk;
    await expect(assertBuilderRuntimeStorage(h.input)).rejects.toThrow(/explicit storage migration/);
  });
});
