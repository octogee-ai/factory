import { getStorage } from "firebase-admin/storage";
export declare const FIREBASE_PROJECT_ID: string;
export declare const OCTOGEE_ENV: import("./deployment-environment.js").ResolvedDeploymentEnvironment;
export declare const db: FirebaseFirestore.Firestore;
export declare const platformStateStore: import("./platform-state/store.js").PlatformStateStore;
export { getStorage };
