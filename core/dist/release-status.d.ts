import type { PlatformStateStore } from "./platform-state/index.js";
export declare function imageTagMatchesArtifact(artifactTag: string | null | undefined, expectedImageTag: string): boolean;
export type ReleaseStatusObservation = "converged" | "rolling" | "missing-release" | "missing-runtime" | "runtime-stale" | "heartbeat-stale" | "not-serving" | "unhealthy" | "version-drift" | "paused" | "retired" | "invalid-root";
export interface ReleaseStatusRuntime {
    release: number;
    lifecycle: string;
    heartbeatStatus: string;
    heartbeatVersion: string | null;
    lastHeartbeatAt: number;
}
export interface ReleaseStatusGatewayInput {
    gatewayId: string;
    desiredStatus: string;
    desiredRelease: number;
    liveRelease: number | null;
    desiredImageTag: string | null;
    runtime: ReleaseStatusRuntime | null;
}
export interface ReleaseStatusGateway {
    gatewayId: string;
    isDefault: boolean;
    desiredStatus: string | null;
    desiredRelease: number | null;
    liveRelease: number | null;
    desiredImageTag: string | null;
    runtimeRelease: number | null;
    runtimeLifecycle: string | null;
    heartbeatStatus: string | null;
    heartbeatVersion: string | null;
    lastHeartbeatAt: number | null;
    observation: ReleaseStatusObservation;
}
export interface ReleaseStatusSnapshot {
    defaultGatewayId: string | null;
    defaultSelection: ReleaseStatusDefaultSelection;
    gateways: ReleaseStatusGateway[];
}
export type ReleaseStatusDefaultSelection = "selected" | "unconfigured" | "invalid";
export declare function summarizeReleaseStatus(snapshot: ReleaseStatusSnapshot): {
    status: "converged" | "incomplete";
    serving: number;
    converged: number;
    excluded: number;
    blockers: string[];
};
export declare function observeGatewayRelease(input: ReleaseStatusGatewayInput, now?: number): ReleaseStatusObservation;
export declare function readReleaseStatus(store: PlatformStateStore, now?: number): Promise<ReleaseStatusSnapshot>;
