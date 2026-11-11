import { DocumentData } from "firebase-admin/firestore";
import { DEFAULT_USER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";

export const CREW_ROLES = ["coach"] as const;
export type CrewRole = typeof CREW_ROLES[number];

export const CREW_IDENTITY: Record<CrewRole, { name: string; emoji: string; model: string }> = {
  coach: { name: "Octo", emoji: "🐙", model: DEFAULT_USER_AGENT_MODEL_REF },
};

export interface UserProvisioning {
  slug: string;
  status: string;
  customerDir: string;
  agentIds: string[];
  activatedAgents: string[];
}

export function getProvisioning(data: DocumentData): UserProvisioning | null {
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
