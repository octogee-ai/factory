import { createHmac } from "node:crypto";
import type { Request } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";

import { verifyWorkspaceCommitProof } from "../lib/workspace-commit-proof.js";

const NOW = 1_785_000_000_000;
const PATH = "/internal/workspace/commit";

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

function request(body: Record<string, unknown>, secret: string, timestamp = String(NOW)): Request {
  const serialized = JSON.stringify(body);
  const signature = createHmac("sha256", secret)
    .update(`octogee-workspace-commit-v1\n${timestamp}\n${PATH}\n${serialized}`)
    .digest("hex");
  return {
    body,
    originalUrl: PATH,
    get: (name: string) => {
      if (name.toLowerCase() === "x-octogee-agent-proof-timestamp") return timestamp;
      if (name.toLowerCase() === "x-octogee-agent-proof-signature") return signature;
      return undefined;
    },
  } as unknown as Request;
}

const records = {
  "workspaces/acme": { ownerUid: "owner-acme" },
  "workspaces/victim": { ownerUid: "owner-victim" },
  "users/owner-acme/secrets/coachMattermost": { personalToken: "acme-coach-pat" },
  "users/owner-acme/secrets/projectAgentMattermost-orbit": { personalToken: "acme-orbit-pat" },
  "workspaces/acme/projects/orbit": { agent: { enabled: true } },
  "users/owner-victim/secrets/coachMattermost": { personalToken: "victim-coach-pat" },
};

describe("workspace commit agent proof", () => {
  it("accepts the selected workspace coach for workspace and project checkpoints", async () => {
    const workspace = { agentId: "octogee-acme-coach", slug: "acme" };
    expect(await verifyWorkspaceCommitProof(
      request(workspace, "acme-coach-pat"),
      { ...workspace, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(true);

    const project = { agentId: "octogee-acme-coach", slug: "acme", project: "orbit" };
    expect(await verifyWorkspaceCommitProof(
      request(project, "acme-coach-pat"),
      project,
      fakeDb(records),
      () => NOW,
    )).toBe(true);
  });

  it("accepts a project agent only for its own project", async () => {
    const own = { agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" };
    expect(await verifyWorkspaceCommitProof(
      request(own, "acme-orbit-pat"), own, fakeDb(records), () => NOW,
    )).toBe(true);

    const other = { ...own, project: "other" };
    expect(await verifyWorkspaceCommitProof(
      request(other, "acme-orbit-pat"), other, fakeDb(records), () => NOW,
    )).toBe(false);
  });

  it("rejects a disabled project agent even if its old credential still exists", async () => {
    const own = { agentId: "octogee-acme-proj-orbit-coach", slug: "acme", project: "orbit" };
    const disabled = {
      ...records,
      "workspaces/acme/projects/orbit": { agent: { enabled: false } },
    };
    expect(await verifyWorkspaceCommitProof(
      request(own, "acme-orbit-pat"), own, fakeDb(disabled), () => NOW,
    )).toBe(false);
  });

  it("rejects a cross-tenant slug even when the attacker signs with its own valid secret", async () => {
    const forged = { agentId: "octogee-victim-coach", slug: "victim" };
    expect(await verifyWorkspaceCommitProof(
      request(forged, "acme-coach-pat"),
      { ...forged, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);
  });

  it("rejects stale timestamps and signatures bound to another body", async () => {
    const body = { agentId: "octogee-acme-coach", slug: "acme" };
    expect(await verifyWorkspaceCommitProof(
      request(body, "acme-coach-pat", String(NOW - 31_000)),
      { ...body, project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);

    const signed = request(body, "acme-coach-pat");
    signed.body = { ...body, slug: "victim" };
    expect(await verifyWorkspaceCommitProof(
      signed,
      { agentId: "octogee-victim-coach", slug: "victim", project: null },
      fakeDb(records),
      () => NOW,
    )).toBe(false);
  });
});
