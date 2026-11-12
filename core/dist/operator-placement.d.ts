import { type AssignmentSource } from "@octogee/shared/types/gateway-releases";
import type { PlatformStateRepositories, PlatformStateStore } from "./platform-state/store.js";
export type OperatorPlacementRefusalReason = "user-not-found" | "user-not-admitted" | "user-provisioning-not-started" | "user-slug-missing" | "account-not-interactive" | "restore-in-progress" | "source-transfer-in-progress" | "migration-in-progress" | "assigned-elsewhere" | "gateway-not-found" | "gateway-retired" | "gateway-root-invalid" | "gateway-not-shared" | "gateway-not-running";
export interface OperatorPlacementRefusal {
    kind: "refused";
    reason: OperatorPlacementRefusalReason;
    message: string;
}
export interface OperatorPlacementPlan {
    kind: "plan";
    uid: string;
    slug: string;
    gatewayId: string;
    currentGatewayId: string | null;
    assignmentPresent: boolean;
    mirrorCurrent: boolean;
}
export type OperatorPlacementOutcome = {
    kind: "placed";
    plan: OperatorPlacementPlan;
} | {
    kind: "repaired";
    plan: OperatorPlacementPlan;
} | {
    kind: "unchanged";
    plan: OperatorPlacementPlan;
} | OperatorPlacementRefusal;
export declare const SHARED_GATEWAY_MIRROR: {
    readonly gatewayProfile: "standard";
    readonly controlUiEnabled: false;
};
export declare function planOperatorPlacement(reader: PlatformStateRepositories, input: {
    uid: string;
    gatewayId: string;
}): Promise<OperatorPlacementPlan | OperatorPlacementRefusal>;
export declare function commitOperatorPlacement(store: PlatformStateStore, input: {
    uid: string;
    gatewayId: string;
    source: AssignmentSource;
    now: number;
}): Promise<OperatorPlacementOutcome>;
