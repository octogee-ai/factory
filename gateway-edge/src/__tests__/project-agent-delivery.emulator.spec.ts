import { beforeEach, describe, expect, it } from "vitest";
import { setupEmulatorTest } from "@octogee/test-helpers/firestore-emulator";
import { db } from "../lib/db.js";
import { beginDeliveryPost, claimProjectDelivery, openDeliveryIntent } from "../lib/project-agent-delivery.js";

setupEmulatorTest();

const target = { workspaceId: "alice", projectSlug: "golf" };
const projectPath = "workspaces/alice/projects/golf";
const intentPath = `${projectPath}/agentState/handoffDelivery`;
const intent = async () => (await db.doc(intentPath).get()).data();

beforeEach(async () => {
  await db.doc(projectPath).set({ ownerUid: "u", name: "Fairway", agent: { status: "ready", handoff: { status: "pending" } } });
});

async function openedClaim() {
  const lease = await claimProjectDelivery(target, "u");
  if (!lease) throw new Error("expected a delivery lease");
  return openDeliveryIntent(target, lease);
}

describe("project agent delivery intent (emulator)", () => {
  it("records the post attempt on the intent this worker created", async () => {
    const claim = await openedClaim();

    await beginDeliveryPost(target, claim);

    expect(await intent()).toEqual({ startedAt: expect.any(Number), postAttempted: true });
  });

  it("records the post attempt on an intent an earlier delivery left behind", async () => {
    await db.doc(intentPath).set({ startedAt: 1, recoveryBefore: "cursor" });
    const claim = await openedClaim();

    await beginDeliveryPost(target, claim);

    expect(claim).toMatchObject({ startedAt: 1, recoveryBefore: "cursor", postAttempted: false });
    expect(await intent()).toEqual({ startedAt: expect.any(Number), postAttempted: true });
  });

  it("refuses the post attempt once another worker rewrote the intent this worker opened", async () => {
    const claim = await openedClaim();
    const newer = { startedAt: 7, postAttempted: true, recoveryBefore: "newer-cursor" };
    await db.doc(intentPath).set(newer);

    await expect(beginDeliveryPost(target, claim)).rejects.toThrow("Project delivery lease was replaced");

    expect(await intent()).toEqual(newer);
  });
});
