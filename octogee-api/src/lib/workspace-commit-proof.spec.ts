import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import {
  verifyWorkspaceCommitProof,
  WORKSPACE_COMMIT_PROOF_PATH,
  workspaceCommitProofSignature,
} from "./workspace-commit-proof.js";

const NOW = 1_785_000_000_000;

function fakeDb(records: Record<string, Record<string, unknown>>): Firestore {
  return {
    doc(path: string) {
      return {
        async get() {
          const data = records[path];
          return { exists: data !== undefined, data: () => data };
        },
      };
    },
  } as unknown as Firestore;
}

function proof(body: Record<string, unknown>, secret: string, timestamp = String(NOW)) {
  const serialized = JSON.stringify(body);
  return {
    body: serialized,
    timestamp,
    signature: workspaceCommitProofSignature(secret, timestamp, WORKSPACE_COMMIT_PROOF_PATH, serialized),
  };
}

const records = {
  "workspaces/acme": { ownerUid: "owner-acme" },
  "workspaces/victim": { ownerUid: "owner-victim" },
  "users/owner-acme/secrets/coachMattermost": { personalToken: "acme-coach-pat" },
  "users/owner-acme/secrets/projectAgentMattermost-orbit": { personalToken: "acme-orbit-pat" },
  "workspaces/acme/projects/orbit": { agent: { mode: "scoped", enabled: false } },
  "users/owner-victim/secrets/coachMattermost": { personalToken: "victim-coach-pat" },
};

describe("workspace commit agent proof", () => {
  it("accepts the selected workspace coach for workspace and project checkpoints", async () => {
    const workspace = { agentId: "octogee-acme-coach", slug: "acme" };
    expect(await verifyWorkspaceCommitProof(
      proof(workspace, "acme-coach-pat"),
      { ...workspace, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(true);

    const project = { agentId: "octogee-acme-coach", slug: "acme", project: "orbit" };
    expect(await verifyWorkspaceCommitProof(
      proof(project, "acme-coach-pat"),
      project,
      fakeDb(records),
      () => NOW,
    )).toBe(true);
  });

  it("accepts a project agent only for its own project", async () => {
    const own = { agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" };
    expect(await verifyWorkspaceCommitProof(
      proof(own, "acme-orbit-pat"), own, fakeDb(records), () => NOW,
    )).toBe(true);

    const other = { ...own, project: "other" };
    expect(await verifyWorkspaceCommitProof(
      proof(other, "acme-orbit-pat"), other, fakeDb(records), () => NOW,
    )).toBe(false);
  });

  it("rejects an agentless project agent even if its old credential and enabled flag still exist", async () => {
    const own = { agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" };
    const disabled = {
      ...records,
      "workspaces/acme/projects/orbit": { agent: { mode: "agentless", enabled: true } },
    };
    expect(await verifyWorkspaceCommitProof(
      proof(own, "acme-orbit-pat"), own, fakeDb(disabled), () => NOW,
    )).toBe(false);
  });

  it("rejects a cross-tenant slug even when the attacker signs with its own valid secret", async () => {
    const forged = { agentId: "octogee-victim-coach", slug: "victim" };
    expect(await verifyWorkspaceCommitProof(
      proof(forged, "acme-coach-pat"),
      { ...forged, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);
  });

  it("rejects stale timestamps and signatures bound to another body", async () => {
    const body = { agentId: "octogee-acme-coach", slug: "acme" };
    expect(await verifyWorkspaceCommitProof(
      proof(body, "acme-coach-pat", String(NOW - 31_000)),
      { ...body, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);

    const signed = proof(body, "acme-coach-pat");
    signed.body = JSON.stringify({ ...body, slug: "victim" });
    expect(await verifyWorkspaceCommitProof(
      signed,
      { agentId: "octogee-victim-coach", slug: "victim", project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);
  });
});
