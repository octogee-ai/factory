/**
 * Multi-provider validation probe.
 *
 * Generalizes Phase 1's anthropic-probe. Each provider has the cheapest
 * possible "is this key alive" call:
 *
 *   anthropic         → POST /v1/messages, max_tokens:1, model=Haiku
 *                       (Anthropic has no free GET endpoint).
 *   openai            → GET /v1/models  (no token cost, instant).
 *   openai-compatible → GET {baseUrl}/models  (most upstreams implement
 *                        the OpenAI-compatible /models endpoint).
 *
 * Reuses Phase 1's classifyHttp() so 401/403 → user fault, 429/5xx →
 * transient (returns 503 from the route).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyHttp } from "./anthropic-probe";
import { logger } from "../middleware/logging";
import type { Provider } from "./provider-key-format";

export interface ProbeRequest {
  provider: Provider;
  apiKey: string;
  /** Required for openai-compatible. */
  baseUrl?: string;
}

export interface ProbeResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  classification?: "user" | "transient";
}

const TIMEOUT_MS = 8000;

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/models";

function trimSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Classify an IP (v4 or v6) as private / link-local / loopback / ULA /
 * cloud-metadata. Used by the SSRF guard to reject DNS lookups that
 * resolve to internal addresses even when the hostname itself looks
 * innocuous (DNS rebinding).
 */
function isPrivateAddress(ip: string): boolean {
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true; // link-local incl. cloud metadata
  if (/^0\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT
  if (ip === "::1") return true;
  if (/^fe80:/i.test(ip)) return true; // link-local
  if (/^fc[0-9a-f]{2}:/i.test(ip)) return true; // ULA
  // ::ffff:x.y.z.w — IPv4-mapped IPv6. Strip the prefix and re-check.
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped && isPrivateAddress(v4Mapped[1])) return true;
  return false;
}

/**
 * Reject openai-compatible base URLs that would steer the probe at
 * internal infrastructure: cloud metadata services, link-local, loopback,
 * private RFC1918 ranges, or non-https schemes. The probe runs inside
 * workspace-api with access to cluster DNS — an attacker who can set
 * `baseUrl` could otherwise query `http://metadata.google.internal/...`
 * and exfiltrate secrets via our probeFetch response body. Two layers:
 *   1. Reject obviously-internal hostnames.
 *   2. DNS-resolve the hostname and reject any private/link-local IP —
 *      this catches attacker-controlled DNS that points `evil.com` at
 *      169.254.169.254. A small TOCTOU window remains (DNS could flip
 *      between our lookup and fetch's own lookup), but most resolvers
 *      cache for ≥1s which is well inside fetch's connect window.
 * CodeQL js/request-forgery.
 */
async function validateCompatibleBaseUrl(baseUrl: string): Promise<string | null> {
  let u: URL;
  try { u = new URL(baseUrl); } catch { return "Invalid baseUrl"; }
  if (u.protocol !== "https:") return "baseUrl must use https://";
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "metadata.google.internal" ||
    host.endsWith(".internal") ||
    host.endsWith(".svc.cluster.local")
  ) {
    return "baseUrl host not permitted";
  }
  // Literal-IP input: validate directly without DNS.
  if (isIP(host)) {
    if (isPrivateAddress(host)) return "baseUrl host not permitted";
    return null;
  }
  // Hostname: resolve and validate every returned address.
  try {
    const resolved = await lookup(host, { all: true });
    for (const { address } of resolved) {
      if (isPrivateAddress(address)) return "baseUrl host not permitted";
    }
  } catch {
    return "baseUrl host could not be resolved";
  }
  return null;
}

async function probeFetch(
  url: string,
  init: RequestInit,
): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ac.signal });
    if (resp.ok) return { ok: true, httpStatus: resp.status };

    let detail = "";
    try {
      const body = (await resp.json()) as { error?: { type?: string; message?: string }; message?: string };
      detail = body?.error?.type || body?.error?.message || body?.message || "";
    } catch {
      // Short cap (80 chars) on the raw fallback text. A GCP metadata-service
      // access token is hundreds of characters long — keeping this below
      // that length means even a successful SSRF to the metadata endpoint
      // can't leak the full token via our error body.
      detail = (await resp.text().catch(() => "")).slice(0, 80);
    }
    return {
      ok: false,
      httpStatus: resp.status,
      error: detail || `Upstream returned HTTP ${resp.status}`,
      classification: classifyHttp(resp.status),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: `Probe timed out after ${TIMEOUT_MS}ms`, classification: "transient" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[byot-probe] network error: ${msg}`);
    return { ok: false, error: `Probe failed: ${msg}`, classification: "transient" };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeProviderKey(req: ProbeRequest): Promise<ProbeResult> {
  if (req.provider === "anthropic") {
    return probeFetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": req.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  }

  if (req.provider === "openai") {
    return probeFetch(OPENAI_ENDPOINT, {
      method: "GET",
      headers: { Authorization: `Bearer ${req.apiKey}` },
    });
  }

  if (req.provider === "openai-compatible") {
    if (!req.baseUrl) {
      // Bad input from the caller, not a transient upstream issue —
      // surface as user-fault so the route returns 400.
      return {
        ok: false,
        error: "baseUrl is required for openai-compatible providers",
        classification: "user",
      };
    }
    const validationError = await validateCompatibleBaseUrl(req.baseUrl);
    if (validationError) {
      return { ok: false, error: validationError, classification: "user" };
    }
    return probeFetch(`${trimSlash(req.baseUrl)}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${req.apiKey}` },
    });
  }

  // Exhaustiveness guard.
  const _exhaustive: never = req.provider;
  return {
    ok: false,
    error: `Unsupported provider: ${String(_exhaustive)}`,
    classification: "user",
  };
}
