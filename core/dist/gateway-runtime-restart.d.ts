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
export declare function updateRuntimeRestart(store: PlatformStateStore, current: RuntimeRestartFence, next: RuntimeRestartFence | null, validate?: (transaction: PlatformStateTransaction, root: Stored<GatewayRoot>) => Promise<void>): Promise<void>;
