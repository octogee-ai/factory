import type { Request } from "express";
import { describe, expect, it } from "vitest";

import {
  createAgentSupportTurnVerifier,
  createOwnerWorkspaceTurnVerifier,
  createProjectWorkspaceTurnVerifier,
} from "./openclaw-owner-turn.js";

const OWNER = "uid-eggman";

function runnableProject(overrides: Record<string, unknown> = {}) {
  return {
    ownerUid: OWNER,
    ownerActive: true,
    status: "building",
    provisioningState: "active",
    ...overrides,
  };
}

function fakeDb(input: {
  workspace?: Record<string, unknown>;
  project?: Record<string, unknown>;
} = {}) {
  const docs: Record<string, Record<string, unknown> | undefined> = {
    "workspaces/eggman": input.workspace,
    "workspaces/eggman/projects/orbit": input.project,
  };
  return {
    doc: (path: string) => ({
      get: async () => ({ exists: docs[path] !== undefined, data: () => docs[path] }),
    }),
  } as never;
}

const activeWorkspace = { ownerUid: OWNER, ownerActive: true };

function turn(overrides: Partial<{
  agentId: string;
  ownerUid: string;
  assignedData: Record<string, unknown>;
}> = {}) {
  return {
    req: { body: {} } as Request,
    gatewayId: "shared-slot",
    agentId: overrides.agentId ?? "octogee-eggman-coach",
    ownerUid: overrides.ownerUid ?? OWNER,
    assignedData: overrides.assignedData ?? { workspaceId: "eggman" },
  };
}

const projectAgent = "octogee-eggman-proj-orbit-coach";

describe("createOwnerWorkspaceTurnVerifier", () => {
  it("allows the workspace coach without any originating Mattermost turn", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(fakeDb({ workspace: activeWorkspace }));

    await expect(verify(turn())).resolves.toBe(true);
  });

  it.each([
    ["the workspace is missing", {}],
    ["the workspace belongs to another owner", { workspace: { ownerUid: "uid-other", ownerActive: true } }],
    ["the owner is suspended", { workspace: { ownerUid: OWNER, ownerActive: false } }],
  ])("refuses when %s", async (_case, db) => {
    const verify = createOwnerWorkspaceTurnVerifier(fakeDb(db));

    await expect(verify(turn())).resolves.toBe(false);
  });

  it("refuses a coach of a workspace the calling gateway is not serving", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(fakeDb({ workspace: activeWorkspace }));

    await expect(verify(turn({ assignedData: { workspaceId: "tails" } }))).resolves.toBe(false);
  });

  it("refuses a project agent", async () => {
    const verify = createOwnerWorkspaceTurnVerifier(
      fakeDb({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });
});

describe("createProjectWorkspaceTurnVerifier", () => {
  it("allows a runnable project's agent without any originating Mattermost turn", async () => {
    const verify = createProjectWorkspaceTurnVerifier(
      fakeDb({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(true);
  });

  it.each([
    ["the project is missing", undefined],
    ["the project belongs to another owner", runnableProject({ ownerUid: "uid-other" })],
    ["the project is archived", runnableProject({ commercialLifecycle: { status: "archived" } })],
    ["the project is still provisioning", runnableProject({ provisioningState: "provisioning" })],
  ])("refuses when %s", async (_case, project) => {
    const verify = createProjectWorkspaceTurnVerifier(fakeDb({ workspace: activeWorkspace, project }));

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });

  it("refuses when the owner is suspended", async () => {
    const verify = createProjectWorkspaceTurnVerifier(fakeDb({
      workspace: { ownerUid: OWNER, ownerActive: false },
      project: runnableProject(),
    }));

    await expect(verify(turn({ agentId: projectAgent }))).resolves.toBe(false);
  });

  it("refuses the workspace coach", async () => {
    const verify = createProjectWorkspaceTurnVerifier(
      fakeDb({ workspace: activeWorkspace, project: runnableProject() }),
    );

    await expect(verify(turn())).resolves.toBe(false);
  });
});

describe("createAgentSupportTurnVerifier", () => {
  const db = fakeDb({ workspace: activeWorkspace, project: runnableProject() });

  it("verifies a project agent through the project lane", async () => {
    await expect(createAgentSupportTurnVerifier(db)(turn({ agentId: projectAgent }))).resolves.toBe(true);
  });

  it("verifies a workspace coach through the owner lane", async () => {
    await expect(createAgentSupportTurnVerifier(db)(turn())).resolves.toBe(true);
  });

  it("refuses an identity that is neither a coach nor a project agent", async () => {
    await expect(createAgentSupportTurnVerifier(db)(turn({ agentId: "some-other-agent" }))).resolves.toBe(false);
  });
});
