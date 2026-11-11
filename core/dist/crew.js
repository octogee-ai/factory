import { DEFAULT_USER_AGENT_MODEL_REF } from "@octogee/shared/types/platform-config";
export const CREW_ROLES = ["coach"];
export const CREW_IDENTITY = {
    coach: { name: "Octo", emoji: "🐙", model: DEFAULT_USER_AGENT_MODEL_REF },
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
