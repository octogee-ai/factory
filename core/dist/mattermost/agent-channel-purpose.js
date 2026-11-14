export const defaultAgentChannelPurpose = (ownerLabel) => `${ownerLabel}'s private channel with their agent`;
const PURPOSE_SLOT = Symbol.for("platform.agentChannelPurpose");
export function installAgentChannelPurpose(purpose) {
    globalThis[PURPOSE_SLOT] = purpose;
}
export function agentChannelPurpose(ownerLabel) {
    return (globalThis[PURPOSE_SLOT] ?? defaultAgentChannelPurpose)(ownerLabel);
}
