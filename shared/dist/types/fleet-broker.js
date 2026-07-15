export const MAC_OPS_PAT_DESCRIPTION = "Octogee Mac ops agent (OpenClaw)";
export function macOpsPatDescription(gatewayId, revisionId) {
    if (revisionId === gatewayId)
        return MAC_OPS_PAT_DESCRIPTION;
    return `${MAC_OPS_PAT_DESCRIPTION} [revision=${revisionId}]`;
}
