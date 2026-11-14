import { type Firestore } from "firebase-admin/firestore";
import { type Storage } from "firebase-admin/storage";
export declare const FIREBASE_PROJECT_ID: string;
export declare const OCTOGEE_ENV: import("./deployment-environment.js").ResolvedDeploymentEnvironment;
export declare const db: Firestore;
export declare const platformStateStore: import("./platform-state/store.js").PlatformStateStore;
export declare function getStorage(): Storage;
