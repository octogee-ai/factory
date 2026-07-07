import * as fs from "node:fs";
import * as path from "node:path";

// On-disk mirror of the reconcile's applied-fingerprint bookkeeping. appliedFp in
// memory alone cannot survive a container restart with the emptyDir intact: on the
// first tick every mounted slug would lazy-seed as "current" (content-convergence.ts)
// and a snapshot change that landed during the downtime would not converge until the
// NEXT change. Persisting next to the customer state closes that window; a fresh pod
// has no file AND no mounted customers, so everything re-ensures and re-records anyway.
//
// Corrupt or missing files load as empty — the reconcile then lazy-seeds exactly as it
// does for a legacy boot, which is degraded-but-correct, never wedged.

export function loadAppliedFingerprints(filePath: string): Map<string, string> {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return new Map();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  const map = new Map<string, string>();
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const [slug, fp] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof fp === "string" && fp.length > 0) map.set(slug, fp);
    }
  }
  return map;
}

export function saveAppliedFingerprints(filePath: string, applied: ReadonlyMap<string, string>): void {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp`,
  );
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(applied)), "utf-8");
  fs.renameSync(tmp, filePath);
}
