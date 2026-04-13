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
      const body = (await resp.json()) as any;
      detail = body?.error?.type || body?.error?.message || body?.message || "";
    } catch {
      detail = (await resp.text().catch(() => "")).slice(0, 200);
    }
    return {
      ok: false,
      httpStatus: resp.status,
      error: detail || `Upstream returned HTTP ${resp.status}`,
      classification: classifyHttp(resp.status),
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, error: `Probe timed out after ${TIMEOUT_MS}ms`, classification: "transient" };
    }
    logger.warn(`[byot-probe] network error: ${err?.message || err}`);
    return { ok: false, error: `Probe failed: ${err?.message || err}`, classification: "transient" };
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
