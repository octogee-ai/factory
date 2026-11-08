import type { Firestore } from "firebase-admin/firestore";
import type { ExpirySweepResult } from "../store.js";
export declare const FIRESTORE_ACCESS_GRANT_COLLECTIONS: readonly ["gatewayTickets", "openclawControlTickets", "openclawControlSessions"];
export declare function sweepExpiredFirestoreState(db: Firestore, now: number, limit: number): Promise<ExpirySweepResult>;
