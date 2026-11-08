import type { DocumentSnapshot } from "firebase-admin/firestore";
import type { FleetRegistryRecord, FleetRegistryRepository } from "../fleet-registry.js";
import type { Stored } from "../store.js";
import type { FirestoreSession } from "./session.js";
import type { FirestoreWatchSourceFactory } from "./watch.js";
export declare function decodeFleetRegistryRecord(snapshot: DocumentSnapshot): Stored<FleetRegistryRecord> | null;
export declare function applyRecordPatch<T extends object>(record: T, patch: object): T;
export declare function createFirestoreFleetRegistryRepository(session: FirestoreSession): FleetRegistryRepository;
export declare const firestoreFleetRegistryWatchSource: FirestoreWatchSourceFactory<"fleetRegistry">;
