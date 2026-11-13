import { type KeyObject } from "node:crypto";
export declare const OPERATOR_KEY_ISSUER = "octogee-operator-key";
export declare function signOperatorToken(options: {
    readonly privateKey: string;
    readonly subject: string;
    readonly now?: () => number;
    readonly lifetimeSeconds?: number;
}): string;
export declare function operatorPublicKey(pem: string): KeyObject;
export declare function verifyOperatorToken(token: string, key: KeyObject, now: number): string;
