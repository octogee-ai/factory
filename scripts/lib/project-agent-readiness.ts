import { createHash } from "node:crypto";
import { projectAgentId } from "../../shared/types/identity.js";
import type { FleetBrokerChannelBinding, FleetBrokerProjectAgent, FleetBrokerProjectAgentReadiness } from "../../shared/types/fleet-broker.js";

interface AccountStatus { accountId?: string; running?: boolean; connected?: boolean; lastStartAt?: number | null }

interface RuntimeConfig {
  agents?: { entries?: Record<string, unknown> };
  channels?: { mattermost?: { accounts?: Record<string, unknown> } };
  bindings?: Array<{ agentId?: string; match?: { channel?: string; accountId?: string; peer?: { kind?: string; id?: string } } }>;
}

function runtimeProjectBound(config: RuntimeConfig, agentId: string, accountId: string, channelIds: string[]): boolean {
  if (!config.agents?.entries?.[agentId] || !config.channels?.mattermost?.accounts?.[accountId] || channelIds.length === 0) return false;
  const bindings = config.bindings?.filter((binding) => binding.agentId === agentId &&
    binding.match?.channel === "mattermost" && binding.match.accountId === accountId) ?? [];
  return bindings.some((binding) => !binding.match?.peer) && channelIds.every((channelId) =>
    bindings.some((binding) => binding.match?.peer?.kind === "group" && binding.match.peer.id === channelId));
}

function accountActivated(account: AccountStatus | undefined, baseline: number | undefined): boolean {
  return account?.running === true && account.connected === true &&
    typeof account.lastStartAt === "number" && Number.isFinite(baseline) && account.lastStartAt > baseline!;
}

export async function reportProjectAgentReadiness(input: {
  uid: string;
  slug: string;
  projectAgents: readonly FleetBrokerProjectAgent[];
  channels: readonly FleetBrokerChannelBinding[];
  baseline: Readonly<Record<string, number>>;
  rpc: { configGet(): Promise<{ config: unknown; configRevisionHash?: string; appliedConfigHash?: string | null }>; channelsStatus(): Promise<unknown> };
  report(uid: string, projects: FleetBrokerProjectAgentReadiness[]): Promise<void>;
}): Promise<void> {
  const active = input.projectAgents.filter((agent) => agent.enabled && agent.status === "provisioning" && agent.token && agent.activationId);
  if (active.length === 0) return;
  const snapshot = await input.rpc.configGet();
  if (!snapshot.configRevisionHash || snapshot.appliedConfigHash !== snapshot.configRevisionHash) {
    throw new Error("Project Agent configuration has not been applied by the runtime");
  }
  const config = snapshot.config as RuntimeConfig;
  const statuses = await input.rpc.channelsStatus() as {
    channelAccounts?: { mattermost?: AccountStatus[] };
  };
  const errors: Error[] = [];
  for (const agent of active) {
    const agentId = projectAgentId(input.slug, agent.projectId);
    const accountId = `${input.slug}-proj-${agent.projectId}`;
    const account = statuses.channelAccounts?.mattermost?.find((entry) => entry.accountId === accountId);
    const channelIds = [...new Set(input.channels.filter((channel) =>
      channel.scope === "project" && channel.projectId === agent.projectId && channel.kind !== "admin"
    ).map((channel) => channel.channelId))].sort();
    if (!runtimeProjectBound(config, agentId, accountId, channelIds) || !accountActivated(account, input.baseline[accountId])) {
      errors.push(new Error(`Project Agent ${agent.projectId} is not connected to its configured channels`));
      continue;
    }
    const project = {
      projectId: agent.projectId,
      activationId: agent.activationId!,
      tokenHash: createHash("sha256").update(agent.token!).digest("hex"),
      channelIds,
    };
    try {
      await input.report(input.uid, [project]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      errors.push(new Error(`Project Agent ${agent.projectId} readiness report failed: ${reason}`, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
  }
}
