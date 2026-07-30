import { DocumentData } from "firebase-admin/firestore";
import { DEFAULT_BUILDER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";

export const CREW_ROLES = ["coach"] as const;
export type CrewRole = typeof CREW_ROLES[number];

export const CREW_IDENTITY: Record<CrewRole, { name: string; emoji: string; model: string }> = {
  coach: { name: "Octo", emoji: "🐙", model: DEFAULT_BUILDER_AGENT_MODEL_REF },
};

export const TIERS = ["trial", "free", "hobby", "pro", "max"] as const;
export type Tier = typeof TIERS[number];

export const TIER_CREW_ACCESS: Record<string, CrewRole[]> = {
  trial: ["coach"],
  free:  ["coach"],
  hobby: ["coach"],
  pro:   ["coach"],
  max:   ["coach"],
};

export const TIER_COLLABORATOR_LIMITS: Record<string, number> = {
  free:  0,
  trial: 3,
  hobby: 3,
  pro:   10,
  max:   Infinity,
};

export interface CustomerProvisioning {
  slug: string;
  status: string;
  customerDir: string;
  agentIds: string[];
  activatedAgents: string[];
}

export function getProvisioning(data: DocumentData): CustomerProvisioning | null {
  const oc = data.provisioning?.openclaw;
  if (!oc?.slug || !oc?.status) return null;
  return {
    slug:             oc.slug,
    status:           oc.status,
    customerDir:      oc.customerDir || "",
    agentIds:         oc.agentIds || [],
    activatedAgents:  oc.activatedAgents || [],
  };
}
