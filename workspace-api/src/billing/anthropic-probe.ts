/**
 * 1-token Anthropic validation probe.
 *
 * Called from POST /byot-key before we write anything to Secret Manager
 * or Firestore. Catches obvious "bad key" and "wrong account" errors
 * without the user waiting for their next Mattermost message to fail.
 *
 * Uses global fetch (Node 22+). No SDK dependency — we only need one
 * endpoint and one verb, and adding the Anthropic SDK just for probing
 * would be overkill.
 */
import { logger } from "../middleware/logging";

export interface ProbeResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  /**
   * "user"      — key is genuinely bad / wrong account / unauthorized.
   *                Reject the customer's request with 400.
   * "transient" — Anthropic is rate-limiting, having an outage, or the
   *                network call failed. Customer's key may be fine; tell
   *                them to retry. Surface as 503.
   */
  classification?: "user" | "transient";
}

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001"; // cheapest available model
const TIMEOUT_MS = 8000;

export async function probeAnthropicKey(apiKey: string): Promise<ProbeResult> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    const resp = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: ac.signal,
    });

    if (resp.ok) {
      return { ok: true, httpStatus: resp.status };
    }

    // Anthropic returns a structured error; surface the `type` so the
    // client can render useful guidance.
    let detail = "";
    try {
      const body = (await resp.json()) as any;
      detail = body?.error?.type || body?.error?.message || "";
    } catch {
      detail = (await resp.text()).slice(0, 200);
    }
    return {
      ok: false,
      httpStatus: resp.status,
      error: detail || `Anthropic returned HTTP ${resp.status}`,
      classification: classifyHttp(resp.status),
    };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return {
        ok: false,
        error: `Anthropic probe timed out after ${TIMEOUT_MS}ms`,
        classification: "transient",
      };
    }
    logger.warn(`[byot-probe] network error: ${err?.message || err}`);
    return {
      ok: false,
      error: `Anthropic probe failed: ${err?.message || err}`,
      classification: "transient",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 401/403  → user's fault (key is invalid / wrong account / no permissions).
 * 429      → upstream rate limit. Customer's key is probably fine.
 * 5xx      → upstream outage. Customer's key is probably fine.
 * Other 4xx (400 invalid_request etc.) → user's fault — bad model / bad payload
 *                                         on our side, but symptomatically the
 *                                         client should know.
 */
export function classifyHttp(status: number): "user" | "transient" {
  if (status === 401 || status === 403) return "user";
  if (status === 429) return "transient";
  if (status >= 500) return "transient";
  return "user";
}
