import type { PlatformStateStore } from "../store.js";
import type { PlatformStateLogger } from "./session.js";
export interface PlatformStateStoreSelection {
    readonly applicationName: string;
    readonly createFirestoreStore: () => PlatformStateStore;
    readonly logger: PlatformStateLogger;
    readonly environment?: Readonly<Record<string, string | undefined>>;
}
export interface PlatformStateStoreTargetSelection extends PlatformStateStoreSelection {
    readonly deploymentTargetId: string;
}
export declare function platformStateStoreFromEnvironment(selection: PlatformStateStoreSelection): PlatformStateStore;
export declare function platformStateStoreForDeploymentTarget(selection: PlatformStateStoreTargetSelection): Promise<PlatformStateStore>;
