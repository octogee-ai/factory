import type { Firestore, Transaction } from "firebase-admin/firestore";
import { type GatewayDoc } from "@octogee/shared/types/gateway-releases";
import type { GatewayMutableConfig } from "@octogee/shared/types/gateway-mutable-config";
type DurableGateway = GatewayDoc & GatewayMutableConfig;
export declare function disposableBuilderPrelaunchReserved(input: {
    db: Firestore;
    gateway: DurableGateway;
    transaction?: Transaction;
    expectedGateway?: DurableGateway;
    activationBoot?: true;
}): Promise<boolean>;
export declare function disposableBuilderBootMode(input: {
    db: Firestore;
    gateway: DurableGateway;
    transaction: Transaction;
}): Promise<{
    mode: "prelaunch" | "normal" | "activating";
    migrationId?: string;
}>;
export {};
