import { platformStateStore } from "./platform-state.js";
import { isSafeAgentId } from "@octogee/core/byosub-restore";

export interface ResolvedGateway {
  slug: string;
  gatewayId: string;
  agentIds: string[];
}

export function rosteredAgentIdsForSlug(userData: unknown, slug: string): string[] {
  const coach = `octogee-${slug}-coach`;
  const openclaw = (userData as { provisioning?: { openclaw?: { agentIds?: unknown } | null } | null } | null)
    ?.provisioning?.openclaw;
  const listed = Array.isArray(openclaw?.agentIds) ? openclaw.agentIds : [];
  const own = listed.filter(
    (id): id is string =>
      typeof id === "string" && isSafeAgentId(id) && id.startsWith(`octogee-${slug}-`),
  );
  return [coach, ...own.filter((id) => id !== coach)];
}

export async function resolveUserGateway(uid: string): Promise<ResolvedGateway | null> {
  const builder = await platformStateStore.builders.records.get(uid);
  const slug = builder?.slug;
  const gatewayId = builder?.gateway?.gatewayId;
  if (!slug || !gatewayId) return null;
  return {
    slug,
    gatewayId,
    agentIds: rosteredAgentIdsForSlug({ provisioning: { openclaw: { agentIds: builder.agents.agentIds } } }, slug),
  };
}
