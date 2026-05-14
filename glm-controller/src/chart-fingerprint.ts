import { createHash } from "node:crypto";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * Stable SHA-256 fingerprint of a helm chart directory.
 *
 * Walks the chart tree (templates, Chart.yaml, values*.yaml, _helpers,
 * NOTES.txt, etc.) in lexicographic order, hashing each file's relative
 * path and contents. The result is deterministic across pods rendering
 * the same chart bytes.
 *
 * Cowboy stores this fingerprint as a helm `--set` value when it
 * upserts a release; on subsequent reconciles it compares the current
 * on-disk fingerprint against the stored value. A mismatch triggers a
 * helm re-apply, even when image-tag / instanceName / gatewayId are
 * unchanged — which is the case when a chart template change ships via
 * a glm-controller image rebuild.
 */
export function computeChartFingerprint(chartPath: string): string {
  const hash = createHash("sha256");
  for (const rel of walkSorted(chartPath)) {
    hash.update(rel);
    hash.update("\0");
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chart path is operator-controlled at boot, walker is internal-only
    hash.update(readFileSync(join(chartPath, rel)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkSorted(root: string): string[] {
  const out: string[] = [];
  const walk = (relDir: string): void => {
    const abs = relDir === "" ? root : join(root, relDir);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- chart path is operator-controlled at boot, walker is internal-only
    const entries = readdirSync(abs).sort();
    for (const entry of entries) {
      const relPath = relDir === "" ? entry : `${relDir}/${entry}`;
      const absPath = join(root, relPath);
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- chart path is operator-controlled at boot, walker is internal-only
      const st = lstatSync(absPath);
      if (st.isDirectory()) {
        walk(relPath);
      } else if (st.isFile()) {
        out.push(relPath);
      }
    }
  };
  walk("");
  return out;
}
