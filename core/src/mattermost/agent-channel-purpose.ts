export type AgentChannelPurpose = (ownerLabel: string) => string;

export const defaultAgentChannelPurpose: AgentChannelPurpose = (ownerLabel) =>
  `${ownerLabel}'s private channel with their agent`;

const PURPOSE_SLOT = Symbol.for("platform.agentChannelPurpose");

type PurposeHost = typeof globalThis & { [PURPOSE_SLOT]?: AgentChannelPurpose };

export function installAgentChannelPurpose(purpose: AgentChannelPurpose): void {
  (globalThis as PurposeHost)[PURPOSE_SLOT] = purpose;
}

export function agentChannelPurpose(ownerLabel: string): string {
  return ((globalThis as PurposeHost)[PURPOSE_SLOT] ?? defaultAgentChannelPurpose)(ownerLabel);
}
