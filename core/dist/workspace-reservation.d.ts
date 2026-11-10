import type { PlatformStateStore } from "./platform-state/store.js";
export type WorkspaceReservation = "created" | "existing" | "taken";
export declare function reserveWorkspace(store: Pick<PlatformStateStore, "transaction">, slug: string, ownerUid: string): Promise<WorkspaceReservation>;
