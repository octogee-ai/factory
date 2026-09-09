import { describe, expect, it } from "vitest";
import { configuredBuilderManagedProjectIds, configuredBuilderProjectAgentPatch } from "../lib/configured-builder-project-agents.js";
import { mattermostAccountSecretRef } from "../lib/mattermost-account-secrets.js";
import { buildCustomerBindings, buildProjectAgentAccounts, buildProjectAgents } from "../lib/openclaw-config-builders.js";

const slug = "alice";
const projectId = "launch";
const agentId = "octogee-alice-proj-launch-coach";
const projectAgents = [{ projectId, enabled: true, mmUserId: "b".repeat(26), token: "project-pat" }];
const channels = [
  { channelId: "workspace-channel", scope: "workspace" as const },
  { channelId: "launch-channel", scope: "project" as const, projectId },
  { channelId: "retired-channel", scope: "project" as const, projectId: "retired" },
];
const desired = {
  slug,
  managedProjectIds: [projectId, "retired"],
  activationProjectIds: [projectId],
  projectAgentEntries: buildProjectAgents({
    slug,
    customerDir: "/customers/alice",
    agentsDir: "/agents",
    coach: { name: "Coach", emoji: "🐙", model: "seed-model" },
    projectAgents,
    hostCode: "builder-full",
  }),
  projectAccounts: buildProjectAgentAccounts(slug, projectAgents, "a".repeat(26)),
  channels,
};
const customCoach = { id: "octogee-alice-coach", workspace: "/owner/workspace", model: "owner-model", tools: { allow: ["custom-tool"] } };
const importedProject = { id: "octogee-alice-proj-imported-coach", workspace: "/owner/imported-project", model: "owner-import-model" };
const retiredProject = { id: "octogee-alice-proj-retired-coach", workspace: "/customers/alice/projects/retired" };
const existingBindings = [
  ...buildCustomerBindings([{ slug, channels, agentProjects: new Set(["retired", "imported"]) }]),
  { agentId: importedProject.id, match: { channel: "mattermost", accountId: "alice-proj-imported", peer: { kind: "group", id: "imported-channel" } } },
  { agentId: "personal", match: { channel: "telegram", peer: { kind: "direct", id: "owner" } } },
];

function currentConfig(representation: "list" | "entries", extraAgents: Record<string, unknown>[] = []) {
  const roster = [customCoach, importedProject, retiredProject, ...extraAgents];
  return {
    agents: {
      defaults: { workspace: "/owner/default", model: "custom-default" },
      ...(representation === "list" ? { list: roster } : { entries: Object.fromEntries(roster.map(({ id, ...entry }) => [id, entry])) }),
    },
    tools: { allow: ["owner-tool"] },
    bindings: existingBindings,
    channels: { mattermost: { accounts: {
      "alice-coach": { allowFrom: ["owner"], custom: { list: ["coach-preference"] } },
      "alice-proj-retired": { allowFrom: ["old-owner"], groups: ["retired-channel"] },
      "alice-proj-imported": { allowFrom: ["custom-owner"], custom: { list: ["imported-preference"] } },
      "bob-proj-launch": { allowFrom: ["bob"] },
    } } },
  };
}

describe("configuredBuilderProjectAgentPatch", () => {
  it("removes coach project bindings even when no project activation is pending", () => {
    const current = currentConfig("entries", desired.projectAgentEntries);
    current.channels.mattermost.accounts = { ...current.channels.mattermost.accounts, ...desired.projectAccounts };
    const stale = { agentId: "octogee-alice-coach", match: { channel: "mattermost", accountId: "alice-coach", peer: { kind: "group", id: "launch-channel" } } };
    current.bindings = [...current.bindings, stale];
    const result = configuredBuilderProjectAgentPatch(current, { ...desired, activationProjectIds: [] });
    expect(result.patch.bindings).not.toContainEqual(stale);
    expect(result.patch.bindings).toContainEqual(existingBindings.find(binding => binding.match.peer?.id === "workspace-channel"));
  });

  it("retires a deleted platform project while preserving imported and customized accounts", () => {
    const config = currentConfig("entries");
    const accounts = {
      ...config.channels.mattermost.accounts,
      "alice-proj-retired": { botToken: mattermostAccountSecretRef("alice-proj-retired"), allowFrom: ["owner"] },
      "alice-proj-imported": { botToken: "owner-managed-token", allowFrom: ["owner"] },
      "alice-proj-customref": { botToken: { source: "file", provider: "owner", id: "/alice-proj-customref" } },
      "bob-proj-launch": { botToken: mattermostAccountSecretRef("bob-proj-launch") },
    };
    const current = { ...config, channels: { mattermost: { accounts } } };
    const managedProjectIds = configuredBuilderManagedProjectIds(current, slug, []);
    expect(managedProjectIds).toEqual(["retired"]);
    const result = configuredBuilderProjectAgentPatch(current, {
      slug, managedProjectIds, activationProjectIds: [], projectAgentEntries: [], projectAccounts: {}, channels: [],
    });
    expect(result.retiredAgentIds).toEqual([retiredProject.id]);
    expect(result.patch.channels.mattermost.accounts).toEqual({ "alice-proj-retired": null });
    expect(result.patch.bindings.some((binding: { agentId: string }) => binding.agentId === retiredProject.id)).toBe(false);
    expect(result.patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "imported-channel"));
  });

  it("discovers only valid project IDs with the exact platform account secret reference", () => {
    const accounts = Object.fromEntries([
      ["alice-proj-valid", mattermostAccountSecretRef("alice-proj-valid")],
      ["alice-proj-bad-id", mattermostAccountSecretRef("alice-proj-bad-id")],
      [`alice-proj-${"x".repeat(17)}`, mattermostAccountSecretRef(`alice-proj-${"x".repeat(17)}`)],
      ["alice-proj-wrong", mattermostAccountSecretRef("alice-proj-another")],
      ["alice-proj-extra", { ...mattermostAccountSecretRef("alice-proj-extra"), custom: true }],
      ["alice-proj-exec", { ...mattermostAccountSecretRef("alice-proj-exec"), source: "exec" }],
      ["alice-coach", mattermostAccountSecretRef("alice-coach")],
    ].map(([id, botToken]) => [id, { botToken }]));
    expect(configuredBuilderManagedProjectIds({ channels: { mattermost: { accounts } } }, slug, ["launch", "valid"])).toEqual(["launch", "valid"]);
  });

  it.each(["list", "entries"] as const)("adds a project account and routing while retaining customized Builder config (%s)", (representation) => {
    const current = currentConfig(representation);
    const before = structuredClone(current);
    const { patch, replacePaths, retiredAgentIds } = configuredBuilderProjectAgentPatch(current, desired);

    expect(current).toEqual(before);
    expect(Object.keys(patch).sort()).toEqual(["agents", "bindings", "channels"]);
    expect(patch.agents).not.toHaveProperty("defaults");
    if (representation === "entries") {
      expect(Object.keys(patch.agents.entries)).toEqual([agentId]);
      expect(patch.agents.entries[agentId]).toMatchObject({ workspace: "/customers/alice/projects/launch", model: "seed-model" });
    } else {
      expect(patch.agents.list).toContainEqual(customCoach);
      expect(patch.agents.list).toContainEqual(importedProject);
      expect(patch.agents.list).toContainEqual(desired.projectAgentEntries[0]);
    }
    expect(patch.channels).toEqual({ mattermost: { accounts: {
      ...desired.projectAccounts,
      "alice-proj-retired": null,
    } } });
    expect(patch.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch" } });
    expect(patch.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "launch-channel" } } });
    expect(patch.bindings).toContainEqual(existingBindings.at(-1));
    expect(patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "workspace-channel"));
    expect(patch.bindings).toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "imported-channel"));
    expect(patch.bindings).not.toContainEqual(existingBindings.find((binding) => binding.match.peer?.id === "launch-channel"));
    expect(patch.bindings.some((binding: { match: { peer?: { id: string } } }) => binding.match.peer?.id === "retired-channel")).toBe(false);
    expect(retiredAgentIds).toEqual([retiredProject.id]);
    expect(replacePaths).toEqual(["bindings", "channels.mattermost.accounts.alice-proj-retired.allowFrom", "channels.mattermost.accounts.alice-proj-retired.groups"]);
  });

  it.each(["list", "entries"] as const)("keeps owner changes to existing project agents when reconciling credentials (%s)", (representation) => {
    const customized = { id: agentId, workspace: "/owner/project", model: { primary: "custom-project", fallbacks: ["backup"] }, identity: { name: "Custom" }, tools: { allow: ["owner-tool"] } };
    const { patch } = configuredBuilderProjectAgentPatch(currentConfig(representation, [customized]), desired);
    const entry = representation === "entries" ? { ...patch.agents.entries[agentId], id: agentId } : patch.agents.list.find((agent: { id: string }) => agent.id === agentId);
    expect(entry).toEqual({ ...desired.projectAgentEntries[0], ...customized, name: desired.projectAgentEntries[0].name, identity: desired.projectAgentEntries[0].identity });
  });

  it("leaves projects without an active agent unbound instead of restoring a coach fallback", () => {
    const current = currentConfig("entries");
    const { patch, retiredAgentIds } = configuredBuilderProjectAgentPatch(current, {
      ...desired,
      projectAgentEntries: [],
      projectAccounts: {},
    });
    expect(patch.agents).toEqual({ entries: {} });
    expect(patch.channels.mattermost.accounts).toEqual({ "alice-proj-launch": null, "alice-proj-retired": null });
    expect(patch.bindings.some((binding: { match: { peer?: { id: string } } }) => ["launch-channel", "retired-channel"].includes(binding.match.peer?.id ?? ""))).toBe(false);
    expect(retiredAgentIds).toEqual([retiredProject.id]);
  });

  it("retains binding order when desired project routes are already present", () => {
    const first = configuredBuilderProjectAgentPatch(currentConfig("entries"), desired);
    const current = { ...currentConfig("entries"), bindings: [...first.patch.bindings].reverse() };
    expect(configuredBuilderProjectAgentPatch(current, desired).patch.bindings).toEqual(current.bindings);
  });

  it("preserves already-ready project credentials and routing customized by the owner", () => {
    const customized = { id: agentId, workspace: "/owner/project", model: "owner-model" };
    const customAccount = { botToken: "owner-managed-token", allowFrom: ["custom-owner"], groupPolicy: "allowlist" };
    const customBinding = { agentId: "owner-agent", match: { channel: "mattermost", accountId: "alice-proj-launch", peer: { kind: "group", id: "launch-channel" } } };
    const current = currentConfig("entries", [customized]);
    const config = {
      ...current,
      bindings: [customBinding],
      channels: { mattermost: { accounts: { ...current.channels.mattermost.accounts, "alice-proj-launch": customAccount } } },
    };
    const ready = configuredBuilderProjectAgentPatch(config, { ...desired, activationProjectIds: [] }).patch;
    expect(ready.agents.entries[agentId]).toEqual({ workspace: "/owner/project", model: "owner-model", name: desired.projectAgentEntries[0].name, identity: desired.projectAgentEntries[0].identity });
    expect(ready.channels.mattermost.accounts["alice-proj-launch"]).toEqual(customAccount);
    expect(ready.bindings).toEqual([customBinding]);

    const activating = configuredBuilderProjectAgentPatch(config, desired).patch;
    expect(activating.channels.mattermost.accounts["alice-proj-launch"]).toEqual({
      ...desired.projectAccounts["alice-proj-launch"],
      ...customAccount,
      botToken: desired.projectAccounts["alice-proj-launch"].botToken,
    });
    expect(activating.bindings).not.toContainEqual(customBinding);
    expect(activating.bindings).toContainEqual({ agentId, match: { channel: "mattermost", accountId: "alice-proj-launch" } });
  });

  it("rejects account or agent entries that are outside the authoritative project snapshot", () => {
    expect(() => configuredBuilderProjectAgentPatch(currentConfig("entries"), { ...desired, projectAccounts: { ...desired.projectAccounts, "alice-proj-imported": {} } })).toThrow("unmanaged project account");
    expect(() => configuredBuilderProjectAgentPatch(currentConfig("entries"), { ...desired, projectAgentEntries: [...desired.projectAgentEntries, importedProject] })).toThrow("unmanaged project agent");
    expect(() => configuredBuilderProjectAgentPatch(currentConfig("entries"), { ...desired, projectAccounts: {} })).toThrow("project agent account is missing");
    expect(() => configuredBuilderProjectAgentPatch(currentConfig("entries"), { ...desired, activationProjectIds: ["imported"] })).toThrow("unmanaged project activation");
  });
});
