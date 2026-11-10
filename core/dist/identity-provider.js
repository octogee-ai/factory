import { OAuth2Client } from "google-auth-library";
function unverifiedIssuer(token) {
    const payload = token.split(".")[1];
    if (payload === undefined)
        throw new Error("the bearer is not a JWT");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims?.iss !== "string")
        throw new Error("the bearer names no issuer");
    return claims.iss;
}
export function combineIdentityProviders(providers) {
    if (providers.length === 0)
        throw new Error("no identity provider is configured");
    const byIssuer = new Map(providers.flatMap((provider) => provider.issuers.map((issuer) => [issuer, provider])));
    return {
        issuers: [...byIssuer.keys()],
        verifyBearer: async (token) => {
            const provider = byIssuer.get(unverifiedIssuer(token));
            if (provider === undefined)
                throw new Error("the bearer's issuer is not trusted");
            return provider.verifyBearer(token);
        },
    };
}
function verifyWithGoogleKeys() {
    const client = new OAuth2Client();
    return async (idToken, audience) => {
        const ticket = await client.verifyIdToken({ idToken, audience });
        return ticket.getPayload();
    };
}
export function createGoogleIdentityProvider(options) {
    const verify = options.verify ?? verifyWithGoogleKeys();
    const operators = new Set(options.operatorEmails.map((email) => email.toLowerCase()));
    return {
        issuers: ["https://accounts.google.com", "accounts.google.com"],
        verifyBearer: async (token) => {
            const claims = await verify(token, options.audience);
            if (typeof claims?.email !== "string" || claims.email_verified !== true) {
                throw new Error("the Google token has no verified email");
            }
            const email = claims.email.toLowerCase();
            return { ownerId: email, email, operator: operators.has(email) };
        },
    };
}
export function googleIdentityFromEnvironment(env) {
    const audience = env.FLEET_GOOGLE_CLIENT_ID?.trim() ?? "";
    const operatorEmails = (env.FLEET_OPERATOR_EMAILS ?? "").split(",").map((email) => email.trim()).filter((email) => email !== "");
    if (audience === "" && operatorEmails.length === 0)
        return null;
    if (audience === "")
        throw new Error("FLEET_OPERATOR_EMAILS is set without FLEET_GOOGLE_CLIENT_ID");
    if (operatorEmails.length === 0)
        throw new Error("FLEET_GOOGLE_CLIENT_ID is set without FLEET_OPERATOR_EMAILS");
    return createGoogleIdentityProvider({ audience, operatorEmails });
}
