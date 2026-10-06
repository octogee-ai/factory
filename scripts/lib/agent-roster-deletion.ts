import { agentIdBelongsToSlug } from "../../shared/types/agent-models.js";
import { agentIdsFromConfig } from "./byosub-restore.js";
import { log as defaultLog } from "./config.js";
import { isAgentNotFoundRpcError, type GatewayRpcClient } from "./gateway-rpc.js";

export type AgentDeletionStatus = "deleted" | "not-found";

export interface AgentDeletionResult {
  agentId: string;
  status: AgentDeletionStatus;
}

export interface DeleteRosterAgentsOptions {
  rpc: Pick<GatewayRpcClient, "agentsDelete">;
  log?: (msg: string) => void;
  logPrefix?: string;
}

const AGENT_DELETE_PROGRESS_INTERVAL_MS = 15_000;

export function customerAgentIdsInRoster(current: unknown, slug: string): string[] {
  return agentIdsFromConfig(current).filter((agentId) => agentIdBelongsToSlug(agentId, slug));
}

export function schedulerHandoffAgentIds(
  current: unknown,
  slug: string,
  localAgentIds: readonly string[],
  partialHandoff: boolean,
): string[] {
  const handedOver = partialHandoff
    ? localAgentIds.filter((agentId) => agentIdBelongsToSlug(agentId, slug))
    : localAgentIds;
  return [...new Set([...handedOver, ...customerAgentIdsInRoster(current, slug)])].sort();
}

/**
 * openclaw 2026.7.2 refuses any config write whose canonical roster drops
 * entries unless the write carries `allowedAgentRosterRemovals`, which only its
 * own `agents.delete` supplies. Removing a departing agent is therefore an RPC
 * per agent, not a roster patch: it deletes the entry, prunes that agent's
 * bindings and cron jobs, closes its sqlite handles and purges its session-store
 * rows.
 *
 * `deleteFiles: false` is deliberate. A customer coach's workspace IS the
 * customer directory, and whether that directory dies is Octogee's call, not
 * openclaw's: an eviction the reconcile cancels mid-flight retains it for
 * re-admission, and a cleanup job carries an explicit `deleteWorkspace` flag.
 * The lifecycle deletes the agent dir, memory sqlite and customer tree itself,
 * at the point where it knows the customer is really gone.
 */
export async function deleteRosterAgents(
  agentIds: readonly string[],
  opts: DeleteRosterAgentsOptions,
): Promise<AgentDeletionResult[]> {
  const log = opts.log ?? defaultLog;
  const prefix = opts.logPrefix ? `${opts.logPrefix} ` : "";
  const results: AgentDeletionResult[] = [];
  const failures: string[] = [];

  for (const agentId of agentIds) {
    const startedAt = Date.now();
    log(`${prefix}agents.delete started agentId=${agentId}`);
    const progressTimer = setInterval(() => {
      log(
        `${prefix}agents.delete pending agentId=${agentId} elapsedMs=${Date.now() - startedAt}`,
      );
    }, AGENT_DELETE_PROGRESS_INTERVAL_MS);
    try {
      const result = await opts.rpc.agentsDelete({ agentId, deleteFiles: false });
      if (result.purgeFailed === true || (result.failed?.length ?? 0) > 0) {
        throw new Error(
          `native cleanup incomplete: purgeFailed=${result.purgeFailed === true} failed=${JSON.stringify(result.failed ?? [])}`,
        );
      }
      log(
        `${prefix}agents.delete completed agentId=${agentId} elapsedMs=${Date.now() - startedAt}`,
      );
      results.push({ agentId, status: "deleted" });
    } catch (err) {
      if (isAgentNotFoundRpcError(err)) {
        log(`${prefix}agents.delete ${agentId} — already absent from the roster`);
        results.push({ agentId, status: "not-found" });
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`⚠ ${prefix}agents.delete ${agentId} failed: ${message}`);
      failures.push(`${agentId} (${message})`);
    } finally {
      clearInterval(progressTimer);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${prefix}agents.delete failed for ${failures.join("; ")}`);
  }
  return results;
}
