import { createHmac, timingSafeEqual } from "crypto";

export function canonicalPayload(jobId: string, rawBody: string): string {
  return `${jobId}\n${rawBody}`;
}

export function signFleetRequest(
  secret: string,
  jobId: string,
  rawBody: string,
): string {
  return createHmac("sha256", secret)
    .update(canonicalPayload(jobId, rawBody))
    .digest("hex");
}

export function verifyFleetRequest(
  secret: string,
  jobId: string,
  rawBody: string,
  headerValue: string | undefined,
): boolean {
  if (!headerValue) return false;
  const expected = signFleetRequest(secret, jobId, rawBody);
  if (expected.length !== headerValue.length) return false;
  try {
    return timingSafeEqual(
      Buffer.from(expected, "utf8"),
      Buffer.from(headerValue, "utf8"),
    );
  } catch {
    return false;
  }
}
