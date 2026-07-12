import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  verifyMattermostCapabilityEvidence,
} from "../lib/mattermost-capability-artifact.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const provenancePath = path.join(
  repoRoot,
  ".github/evidence/mattermost/mattermost-cce485f-slsa.json",
);
const evidencePath = path.join(
  repoRoot,
  ".github/evidence/mattermost/mattermost-cce485f-evidence.json",
);
const trivyArchivePath = path.join(
  repoRoot,
  ".github/evidence/mattermost/mattermost-cce485f-trivy-0.71.1.json.gz",
);
function json(pathname: string): unknown {
  return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
}

function verify(
  provenance: Uint8Array = readFileSync(provenancePath),
  evidence: unknown = json(evidencePath),
  trivyReport: Uint8Array = gunzipSync(readFileSync(trivyArchivePath)),
): string[] {
  return verifyMattermostCapabilityEvidence({
    provenance,
    evidence,
    trivyArchive: readFileSync(trivyArchivePath),
    trivyReport,
    now: new Date("2026-07-11T17:30:00Z"),
  });
}

function recordAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error(`expected record at ${path.join(".")}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`expected record at ${path.join(".")}`);
  }
  return current as Record<string, unknown>;
}

describe("Mattermost capability artifact evidence", () => {
  it("binds the checked-in SLSA statement and accepted Trivy result to the exact artifact", () => {
    expect(verify()).toEqual([]);
  });

  it("rejects a provenance byte change, source revision change, or platform digest change", () => {
    const provenance = Buffer.concat([readFileSync(provenancePath), Buffer.from("\n")]);
    expect(verify(provenance)).toContainEqual(expect.stringContaining("provenance sha256"));

    const revision = structuredClone(json(evidencePath));
    recordAt(revision, "provenance").sourceCommit = "0".repeat(40);
    expect(verify(undefined, revision)).toContainEqual(expect.stringContaining("source commit"));

    const platform = structuredClone(json(evidencePath));
    recordAt(platform, "artifact", "platform").manifestDigest = `sha256:${"0".repeat(64)}`;
    expect(verify(undefined, platform)).toContainEqual(
      expect.stringContaining("platform manifest"),
    );
  });

  it("rejects unresolved or unevidenced HIGH/CRITICAL scan findings", () => {
    const critical = structuredClone(json(evidencePath));
    recordAt(critical, "vulnerabilityScan").criticalCount = 1;
    expect(verify(undefined, critical)).toContainEqual(
      expect.stringContaining("criticalCount"),
    );

    const unaccepted = structuredClone(json(evidencePath));
    recordAt(unaccepted, "vulnerabilityScan", "disposition").acceptedFindings = [];
    expect(verify(undefined, unaccepted)).toContainEqual(
      expect.stringContaining("HIGH finding disposition"),
    );
  });

  it("rejects a byte change in the stored full Trivy report", () => {
    const changed = Buffer.concat([
      gunzipSync(readFileSync(trivyArchivePath)),
      Buffer.from("\n"),
    ]);
    expect(verify(undefined, undefined, changed)).toContainEqual(
      expect.stringContaining("Trivy raw report sha256"),
    );
  });

  it("rejects an unpublished source snapshot that claims promotion readiness", () => {
    const promoted = structuredClone(json(evidencePath)) as Record<string, unknown>;
    promoted.candidate = {
      releaseClass: "unpublished-11.10-source-snapshot",
      deployable: true,
      defaultEnvironments: [],
    };

    expect(verify(undefined, promoted)).toContainEqual(
      expect.stringContaining("candidate deployable must equal false"),
    );
  });
});
