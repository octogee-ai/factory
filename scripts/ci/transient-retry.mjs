export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function transientConnectionCode(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return null;
  seen.add(error);
  if (TRANSIENT_CODES.has(error.code)) return error.code;
  for (const inner of [error.cause, ...(Array.isArray(error.errors) ? error.errors : [])]) {
    const code = transientConnectionCode(inner, seen);
    if (code) return code;
  }
  return null;
}

export const transientStatus = response => TRANSIENT_STATUSES.has(response?.status) ? `HTTP ${response.status}` : null;

export async function retryTransient(label, attempt, {
  transientError = transientConnectionCode, transientResult = () => null, delays = RETRY_DELAYS_MS, sleep = wait,
} = {}) {
  const attempts = delays.length + 1;
  for (let number = 1; ; number++) {
    let reason;
    try {
      const result = await attempt();
      reason = transientResult(result);
      if (!reason) return result;
      if (number === attempts) {
        console.warn(`${label}: attempt ${number} of ${attempts} failed (${reason}); giving up`);
        return result;
      }
      await result.body?.cancel?.();
    } catch (error) {
      reason = transientError(error);
      if (!reason) throw error;
      if (number === attempts) throw new Error(`${label} failed after ${attempts} attempts: ${reason}`, { cause: error });
    }
    const delay = delays[number - 1];
    console.warn(`${label}: attempt ${number} of ${attempts} failed (${reason}); retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

export const fetchWithRetry = (label, url, init, options = {}) =>
  retryTransient(label, () => fetch(url, init), { transientResult: transientStatus, ...options });
