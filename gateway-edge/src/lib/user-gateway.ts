import { db } from "./db.js";
import { primaryWorkspaceSlug } from "@octogee/core/workspace-slugs";
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

// Resolve a user's workspace slug + assigned gateway id from their user doc.
// Shared by the byosub routes (cluster) and the byosub-health locality route
// (per-pod), so both read the same field — provisioning.openclaw.gatewayId.
export async function resolveUserGateway(uid: string): Promise<ResolvedGateway | null> {
  const snap = await db.collection("users").doc(uid).get();
  if (!snap.exists) return null;
  const data = (snap.data() || {}) as {
    username?: string | null;
    provisioning?: {
      openclaw?: { slug?: string | null; gatewayId?: unknown } | null;
    } | null;
  };
  const slug = primaryWorkspaceSlug(data);
  const gatewayId = data?.provisioning?.openclaw?.gatewayId;
  if (!slug || typeof gatewayId !== "string" || !gatewayId) return null;
  return { slug, gatewayId, agentIds: rosteredAgentIdsForSlug(data, slug) };
}
