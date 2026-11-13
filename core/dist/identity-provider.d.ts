export interface VerifiedIdentity {
    readonly ownerId: string;
    readonly email: string | null;
    readonly operator: boolean;
}
export interface IdentityProvider {
    readonly issuers: readonly string[];
    verifyBearer(token: string): Promise<VerifiedIdentity>;
}
export declare function combineIdentityProviders(providers: readonly IdentityProvider[]): IdentityProvider;
export type VerifyGoogleIdToken = (idToken: string, audience: string) => Promise<Record<string, unknown> | undefined>;
export declare function createGoogleIdentityProvider(options: {
    readonly audience: string;
    readonly operatorEmails: readonly string[];
    readonly verify?: VerifyGoogleIdToken;
}): IdentityProvider;
export declare function createOperatorKeyIdentityProvider(options: {
    readonly publicKey: string;
    readonly now?: () => number;
}): IdentityProvider;
export declare function operatorKeyIdentityFromEnvironment(env: Record<string, string | undefined>): IdentityProvider | null;
export declare function googleIdentityFromEnvironment(env: Record<string, string | undefined>): IdentityProvider | null;
