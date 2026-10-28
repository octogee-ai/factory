import type { SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import { customerAgentIdsInRoster, schedulerHandoffAgentIds } from "./agent-roster-deletion.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";

export async function setCustomerChannelsRunning(
  rpc: Pick<GatewayRpcClient, "configGet" | "channelsStop" | "channelsStart">,
  slug: string,
  running: boolean,
): Promise<void> {
  const snapshot = await rpc.configGet();
  const config = snapshot.config as { channels?: { mattermost?: { accounts?: Record<string, unknown> } } };
  const accounts = config.channels?.mattermost?.accounts ?? {};
  for (const accountId of Object.keys(accounts)) {
    if (accountId !== `${slug}-coach` && !accountId.startsWith(`${slug}-proj-`)) continue;
    if (running) await rpc.channelsStart({ channel: "mattermost", accountId });
    else await rpc.channelsStop({ channel: "mattermost", accountId });
  }
}

export async function assertCustomerHasNoScheduledJobs(
  rpc: Pick<GatewayRpcClient, "configGet" | "cronJobCount">,
  slug: string,
  localAgentIds: readonly string[],
): Promise<void> {
  const { config } = await rpc.configGet();
  const agentIds = new Set([...localAgentIds, ...customerAgentIdsInRoster(config, slug)]);
  for (const agentId of agentIds) {
    if (await rpc.cronJobCount(agentId) > 0) {
      throw new Error(`migration blocked: ${agentId} has enabled scheduled jobs; source retained`);
    }
  }
}


export async function migrateCustomerScheduler(
  rpc: Pick<GatewayRpcClient, "configGet" | "schedulerMigration">,
  slug: string,
  localAgentIds: readonly string[],
  request: SchedulerMigrationRequest,
): Promise<SchedulerMigrationResult> {
  const { resolveAgentScope, ...native } = request;
  if (request.phase !== "hold" && resolveAgentScope !== true) return rpc.schedulerMigration(native);
  const { config } = await rpc.configGet();
  const agentIds = schedulerHandoffAgentIds(config, slug, localAgentIds, resolveAgentScope === true || request.retainNonportable === true);
  if (agentIds.length === 0) throw new Error(`Cannot ${request.phase} scheduler for ${slug}: no customer agents`);
  return rpc.schedulerMigration({ ...native, agentIds });
}
