import { setTimeout as delay } from "node:timers/promises";
import type { SchedulerMigrationRequest, SchedulerMigrationResult } from "@octogee/shared/types/fleet-controller";
import { customerAgentIdsInRoster } from "./agent-roster-deletion.js";
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
  if (request.phase !== "hold") return rpc.schedulerMigration(request);
  const { config } = await rpc.configGet();
  const agentIds = [...new Set([...localAgentIds, ...customerAgentIdsInRoster(config, slug)])].sort();
  if (agentIds.length === 0) throw new Error(`Cannot hold scheduler for ${slug}: no customer agents`);
  const deadline = Date.now() + 45_000;
  while (true) {
    const result = await holdReleasingStaleFence(rpc, { ...request, agentIds });
    if (result.drained) return result;
    if (Date.now() >= deadline) throw new Error(`scheduler hold timed out draining ${slug}`);
    await delay(250);
  }
}

const HELD_FOR_MIGRATION = /is held for migration ([^\s"}]+)/u;

async function holdReleasingStaleFence(
  rpc: Pick<GatewayRpcClient, "schedulerMigration">,
  request: SchedulerMigrationRequest & { agentIds: string[] },
): Promise<SchedulerMigrationResult> {
  try {
    return await rpc.schedulerMigration(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stale = HELD_FOR_MIGRATION.exec(message)?.[1];
    if (!stale || stale === request.operationId) throw error;
    try {
      await rpc.schedulerMigration({ operationId: stale, phase: "resume", agentIds: request.agentIds });
    } catch (resumeError) {
      const resumeMessage = resumeError instanceof Error ? resumeError.message : String(resumeError);
      throw new Error(`${message}; resuming the stale fence failed: ${resumeMessage}`);
    }
    return rpc.schedulerMigration(request);
  }
}
