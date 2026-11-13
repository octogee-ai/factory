import { isDeepStrictEqual } from "node:util";
import type { GatewayRoot } from "./platform-state/gateways.js";
import type { PlatformStateStore, PlatformStateTransaction, Stored } from "./platform-state/store.js";

export type RuntimeRestartFence = {
  attemptId: string;
  auditId: string;
  gatewayId: string;
  kind: "process" | "deployment";
  startedAt: number;
  phase: "reserved" | "dispatched" | "acknowledged";
  target?: Record<string, unknown>;
  acknowledgement?: Record<string, unknown>;
};

export async function updateRuntimeRestart(
  store: PlatformStateStore,
  current: RuntimeRestartFence,
  next: RuntimeRestartFence | null,
  validate?: (transaction: PlatformStateTransaction, root: Stored<GatewayRoot>) => Promise<void>,
): Promise<void> {
  await store.transaction({ label: "gateway-runtime-restart.update" }, async (transaction) => {
    const root = await transaction.gateways.roots.get(current.gatewayId);
    if (!root || !isDeepStrictEqual(root.runtimeRestartFence, current)) throw new Error("gateway runtime restart fence changed");
    await validate?.(transaction, root);
    await transaction.gateways.roots.compareAndSetRuntimeRestartFence(current.gatewayId, current, next);
  });
}
