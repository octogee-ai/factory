import { type GatewayClass, type GatewayImageProfile, type GatewayModelBrokerLimits, type GatewayPreemptionSpec, type GatewayProfile, type GatewayServiceAccountSpec, type OperatorGatewayAccessSpec } from "./glm.js";
import { type SizingTier } from "./sizing.js";
export declare const GATEWAY_CONFIG_SCHEMA_VERSION: 1;
export interface GatewayMutableConfig {
    configSchemaVersion: typeof GATEWAY_CONFIG_SCHEMA_VERSION;
    profile: GatewayProfile | null;
    gatewayClass: GatewayClass;
    imageProfile: GatewayImageProfile;
    sizingTier: SizingTier | null;
    computeClass: string | null;
    gcpProject: string | null;
    gatewayContainerSecurityContext: Record<string, unknown> | null;
    serviceAccountName: string | null;
    serviceAccount: GatewayServiceAccountSpec | null;
    operatorAccess: OperatorGatewayAccessSpec | null;
    ownerUid: string | null;
    coOwnerUids: string[];
    builderSlug: string | null;
    openclawOverrides: Record<string, unknown> | null;
    modelBrokerLimits: GatewayModelBrokerLimits | null;
    preemption: GatewayPreemptionSpec | null;
}
export declare function isBareGatewayId(value: unknown): value is string;
export declare function isGatewayMutableConfig(value: unknown): value is GatewayMutableConfig;
export declare function isGatewayMutableConfigForGateway(value: unknown, gatewayId: string): value is GatewayMutableConfig;
export declare function effectiveGatewayServiceAccountNameForGateway(config: GatewayMutableConfig, gatewayId: string): string;
