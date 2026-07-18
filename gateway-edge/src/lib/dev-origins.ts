// Localhost is a development-only affordance. It ships DENIED in every built
// artifact and is enabled only where a local dev server needs it, by setting
// OCTOGEE_ALLOW_LOCAL_ORIGINS=true (the `dev` npm scripts do this). Deployed
// TEST/PROD pods never set it, so no build admits a localhost Origin or
// returnUrl. Mirrors the OCTOGEE_ALLOWED_WS_ORIGINS gate in chat-proxy
// (ws-origin.ts) — config-injected, no NODE_ENV branch.
const ENV_KEY = "OCTOGEE_ALLOW_LOCAL_ORIGINS";
const LOCALHOST_ORIGIN_RE = /^http:\/\/localhost:\d+$/;

export function localDevOriginsAllowed(): boolean {
  return process.env[ENV_KEY] === "true";
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return localDevOriginsAllowed() && LOCALHOST_ORIGIN_RE.test(origin);
}

export function isAllowedLocalhostHostname(hostname: string): boolean {
  return localDevOriginsAllowed() && hostname === "localhost";
}
