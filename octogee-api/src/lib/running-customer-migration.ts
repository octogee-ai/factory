import type { PlatformStateRepositories } from "@octogee/core/platform-state";

export type CustomerMigrationDirection = "inbound" | "outbound";

export async function hasRunningCustomerMigration(
  store: Pick<PlatformStateRepositories, "journal">,
  uid: string,
  gatewayId: string,
  direction: CustomerMigrationDirection,
): Promise<boolean> {
  const operations = await store.journal.operations.listForUid(uid, { kind: "migrate-customer", statuses: ["running"] });
  return operations.some(({ input }) =>
    input.uid === uid && (direction === "inbound" ? input.toGatewayId : input.fromGatewayId) === gatewayId);
}
