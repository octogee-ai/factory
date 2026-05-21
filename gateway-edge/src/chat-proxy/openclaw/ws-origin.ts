// Anchored to the start and end of the string so subdomain spoofs like
// `https://localhost.evil.com` don't match.
const LOCALHOST_RE = /^https?:\/\/localhost(:\d+)?$/;
const ENV_KEY = 'OCTOGEE_ALLOWED_WS_ORIGINS';

export function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (typeof origin !== 'string' || origin.length === 0) return false;

  const configured = parseAllowedOrigins(process.env[ENV_KEY]);
  if (configured.length === 0) {
    return LOCALHOST_RE.test(origin);
  }
  return configured.includes(origin);
}

let warned = false;

export function _resetWsOriginWarningForTests(): void {
  warned = false;
}

export function warnIfWsOriginsMisconfigured(log: (msg: string) => void): void {
  if (warned) return;
  warned = true;
  const raw = process.env[ENV_KEY];
  const configured = parseAllowedOrigins(raw);
  if (configured.length > 0) return;
  if (process.env.K8S_NAMESPACE) {
    log(
      `[ws-origin] WARNING: running in K8S_NAMESPACE=${process.env.K8S_NAMESPACE} but ${ENV_KEY} is unset/empty — chat-proxy is accepting localhost-only WS origins. Set helm values.${'{env}'}.yaml env.allowedWsOrigins to the public app URL.`,
    );
  } else {
    log(`[ws-origin] ${ENV_KEY} unset — accepting localhost-only WS origins (dev mode).`);
  }
}

function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
