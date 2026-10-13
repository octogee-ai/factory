import * as path from "node:path";
import { parseAgentId } from "../../shared/types/identity.js";
import type { DegradedSecretOwner } from "./gateway-rpc.js";

export function unassignedConfiguredAgents(agentIds: string[], assignedSlugs: string[]): Set<string> {
  const assigned = new Set(assignedSlugs);
  return new Set(agentIds.filter((id) => {
    const parsed = parseAgentId(id);
    return parsed.kind !== "unknown" && !assigned.has(parsed.username);
  }));
}

function accountAgent(ownerId: string, agentsDir: string, excluded: Set<string>): string | null {
  let tuple: unknown;
  try { tuple = JSON.parse(ownerId); } catch { return null; }
  if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" ||
      typeof tuple[1] !== "string" || !["anthropic:default", "platform-openrouter:default", "platform-openai:default"].includes(tuple[1])) return null;
  for (const id of excluded) {
    if (tuple[0] === path.join(agentsDir, id, "agent", "openclaw-agent.sqlite")) return id;
  }
  return null;
}

export function stagedSecretWarningsOnly(input: {
  warningCount: number;
  owners: DegradedSecretOwner[];
  excluded: Set<string>;
  agentsDir: string;
}): boolean {
  if (!Number.isSafeInteger(input.warningCount) || input.warningCount <= 0 ||
      input.owners.length !== input.warningCount) return false;
  const identities = new Set<string>();
  for (const owner of input.owners) {
    if (owner.state !== "unavailable" || owner.reason !== "secret provider failed") return false;
    const identity = JSON.stringify([owner.ownerKind, owner.ownerId]);
    if (identities.has(identity)) return false;
    identities.add(identity);
    let agent: string | null = null;
    if (owner.ownerKind === "account") agent = accountAgent(owner.ownerId, input.agentsDir, input.excluded);
    if (owner.ownerKind === "capability" && owner.ownerId.startsWith("memory-provider:")) {
      agent = owner.ownerId.slice("memory-provider:".length);
    }
    if (!agent || !input.excluded.has(agent)) return false;
  }
  return true;
}
