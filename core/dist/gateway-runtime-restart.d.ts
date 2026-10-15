import { type DocumentData, type Firestore, type Transaction } from "firebase-admin/firestore";
export interface RuntimeRestartFence {
    attemptId: string;
    auditId: string;
    gatewayId: string;
    kind: "process" | "deployment";
    startedAt: number;
    phase: "reserved" | "dispatched" | "acknowledged";
    target?: Record<string, unknown>;
    acknowledgement?: Record<string, unknown>;
}
export declare function updateRuntimeRestart(db: Firestore, current: RuntimeRestartFence, next: RuntimeRestartFence | null, validate?: (transaction: Transaction, root: DocumentData) => Promise<void>): Promise<void>;
