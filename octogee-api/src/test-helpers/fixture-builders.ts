import type { BuilderRecord, Revision, Stored } from "@octogee/core/platform-state";

export function fixtureBuilder(uid: string, fields: Partial<BuilderRecord> = {}): Stored<BuilderRecord> {
  return {
    uid,
    slug: null,
    mattermostUserId: null,
    admitted: false,
    persona: null,
    workspaceId: null,
    role: null,
    createdAt: null,
    updatedAt: 0,
    provisioning: {},
    gateway: null,
    openclaw: {},
    agents: { agentIds: [], activatedAgents: [] },
    accountLifecycle: null,
    activationLease: null,
    fences: {},
    home: {},
    ...fields,
    revision: "fixture" as Revision,
  };
}
