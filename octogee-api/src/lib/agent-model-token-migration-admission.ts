import type { BuilderRecord, PlatformStateRepositories, Stored } from "@octogee/core/platform-state";

import { hasRunningCustomerMigration } from "./running-customer-migration.js";

const OUTBOUND_CANDIDATE_LIMIT = 10;

export async function findRunningOutboundMigrationUserByAgentId(
  store: Pick<PlatformStateRepositories, "builders" | "journal">,
  gatewayId: string,
  agentId: string,
): Promise<Stored<BuilderRecord> | null> {
  for (const candidate of await store.builders.records.listByAgentId(agentId, OUTBOUND_CANDIDATE_LIMIT)) {
    if (await hasRunningCustomerMigration(store, candidate.uid, gatewayId, "outbound")) return candidate;
  }
  return null;
}
