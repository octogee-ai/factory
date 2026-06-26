import { db } from "./db.js";
import { primaryWorkspaceSlug } from "@octogee/core/workspace-slugs";

export interface ResolvedGateway {
  slug: string;
  gatewayId: string;
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
  return { slug, gatewayId };
}
