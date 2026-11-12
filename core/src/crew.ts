import { DEFAULT_USER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";

export const CREW_ROLES = ["coach"] as const;
export type CrewRole = typeof CREW_ROLES[number];

export const CREW_IDENTITY: Record<CrewRole, { name: string; emoji: string; model: string }> = {
  coach: { name: "Octo", emoji: "🐙", model: DEFAULT_USER_AGENT_MODEL_REF },
};
