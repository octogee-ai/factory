#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { verifyMattermostCapabilityEvidence } from "../lib/mattermost-capability-artifact.js";

function json(pathname: string): unknown {
  return JSON.parse(readFileSync(pathname, "utf8")) as unknown;
}

export function runVerifyMattermostCapabilityArtifact(
  repoRoot = path.resolve(import.meta.dirname, "../.."),
): number {
  const evidenceDirectory = path.join(repoRoot, ".github/evidence/mattermost");
  const exceptions = json(path.join(repoRoot, ".github/dependency-exceptions.json")) as {
    exceptions?: Array<{ id?: unknown }>;
  };
  const exception = exceptions.exceptions?.find(({ id }) =>
    id === "release/mattermost-silent-post");
  const evidencePath = path.join(evidenceDirectory, "mattermost-cce485f-evidence.json");
  const trivyArchive = readFileSync(path.join(
    evidenceDirectory,
    "mattermost-cce485f-trivy-0.71.1.json.gz",
  ));
  const errors = verifyMattermostCapabilityEvidence({
    provenance: readFileSync(path.join(evidenceDirectory, "mattermost-cce485f-slsa.json")),
    evidence: json(evidencePath),
    evidenceBytes: readFileSync(evidencePath),
    trivyArchive,
    trivyReport: gunzipSync(trivyArchive),
    exception,
  });
  if (errors.length > 0) {
    for (const error of errors) console.error(`Mattermost capability evidence: ${error}`);
    return 1;
  }
  console.log("Mattermost capability artifact evidence verified");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(runVerifyMattermostCapabilityArtifact());
}
