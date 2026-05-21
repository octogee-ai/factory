import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { classifyHttp } from "./anthropic-probe.js";
import { logger } from "../middleware/logging.js";
import type { Provider } from "./provider-key-format.js";

export interface ProbeRequest {
  provider: Provider;
  apiKey: string;
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

function isPrivateAddress(ip: string): boolean {
  if (/^127\./.test(ip)) return true;
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^0\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (ip === "::1") return true;
  if (/^fe80:/i.test(ip)) return true;
  if (/^fc[0-9a-f]{2}:/i.test(ip)) return true;
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4Mapped && isPrivateAddress(v4Mapped[1])) return true;
  return false;
}

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
  if (isIP(host)) {
    if (isPrivateAddress(host)) return "baseUrl host not permitted";
    return null;
  }
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

  const _exhaustive: never = req.provider;
  return {
    ok: false,
    error: `Unsupported provider: ${String(_exhaustive)}`,
    classification: "user",
  };
}
