import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { inventoryRepository } from "../lib/dependency-inventory.js";
import {
  MATTERMOST_CAPABILITY_ARTIFACT,
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
const exceptionsPath = path.join(repoRoot, ".github/dependency-exceptions.json");

function json(pathname: string): unknown {
  return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
}

function mattermostException(): unknown {
  const file = json(exceptionsPath) as { exceptions: Array<{ id?: unknown }> };
  return file.exceptions.find(({ id }) => id === "release/mattermost-silent-post");
}

function verify(
  provenance: Uint8Array = readFileSync(provenancePath),
  evidence: unknown = json(evidencePath),
  exception: unknown = mattermostException(),
  trivyReport: Uint8Array = gunzipSync(readFileSync(trivyArchivePath)),
): string[] {
  return verifyMattermostCapabilityEvidence({
    provenance,
    evidence,
    evidenceBytes: readFileSync(evidencePath),
    trivyArchive: readFileSync(trivyArchivePath),
    trivyReport,
    exception,
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
    expect(verify(undefined, undefined, undefined, changed)).toContainEqual(
      expect.stringContaining("Trivy raw report sha256"),
    );
  });

  it("keeps TEST/restore pending and rejects a false passed claim", () => {
    const exception = mattermostException();
    expect(recordAt(exception, "testRestore").status).toBe("pending");

    const falseClaim = structuredClone(exception);
    recordAt(falseClaim, "testRestore").status = "passed";
    expect(verify(undefined, undefined, falseClaim)).toContainEqual(
      expect.stringContaining("TEST/restore must remain pending"),
    );
  });

  it("keeps inventory and the exception bound to the full repository/tag/digest identity", () => {
    const inventory = inventoryRepository(repoRoot);
    const reference = inventory.references.find(({ path: pathname, packageName }) =>
      pathname === "helm/octogee/values.yaml" &&
      packageName === MATTERMOST_CAPABILITY_ARTIFACT.repository,
    );
    const exception = mattermostException();
    expect(reference).toEqual(recordAt(exception, "reference"));
    expect(reference?.currentValue).toBe(
      `${MATTERMOST_CAPABILITY_ARTIFACT.tag}@${MATTERMOST_CAPABILITY_ARTIFACT.digest}`,
    );
  });
});
