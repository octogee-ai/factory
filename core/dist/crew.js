import { DEFAULT_BUILDER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";
export const CREW_ROLES = ["coach"];
export const CREW_IDENTITY = {
    coach: { name: "Octo", emoji: "🐙", model: DEFAULT_BUILDER_AGENT_MODEL_REF },
};
export const TIERS = ["trial", "free", "hobby", "pro", "max"];
export const TIER_CREW_ACCESS = {
    trial: ["coach"],
    free: ["coach"],
    hobby: ["coach"],
    pro: ["coach"],
    max: ["coach"],
};
export const TIER_COLLABORATOR_LIMITS = {
    free: 0,
    trial: 3,
    hobby: 3,
    pro: 10,
    max: Infinity,
};
export function getProvisioning(data) {
    const oc = data.provisioning?.openclaw;
    if (!oc?.slug || !oc?.status)
        return null;
    return {
        slug: oc.slug,
        status: oc.status,
        customerDir: oc.customerDir || "",
        agentIds: oc.agentIds || [],
        activatedAgents: oc.activatedAgents || [],
    };
}
