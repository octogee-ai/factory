import { createHash } from "node:crypto";

export const MATTERMOST_CAPABILITY_ARTIFACT = {
  repository: "mattermostdevelopment/mattermost-team-edition",
  tag: "cce485f",
  digest: "sha256:ae8c456735a4709deb473cbf37d246e02511ee47b8b6684fadc6980a61d9bfd3",
  sourceCommit: "cce485f60598d8eada1c0afb50d29fa172163bd4",
  platformManifest:
    "sha256:72ed85c315007672567a6d2f4134f58e3bdd2a044f9f6aea2934d9371cba6c75",
  configDigest: "sha256:13bee4ba09d5a8db1676dd4125fe2fd3f9ed10a93c7a4be9da7d5cb6c5125575",
  provenanceDigest:
    "sha256:2bade35578e5e5e4778138f8b6f14fe1de3bf3a3584f3aaae7c829d300cc69a4",
  reference:
    "mattermostdevelopment/mattermost-team-edition:cce485f@sha256:ae8c456735a4709deb473cbf37d246e02511ee47b8b6684fadc6980a61d9bfd3",
} as const;

export interface MattermostCapabilityVerificationInput {
  provenance: Uint8Array;
  evidence: unknown;
  trivyArchive: Uint8Array;
  trivyReport: Uint8Array;
  now?: Date;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    const currentRecord = record(current);
    if (!currentRecord) return undefined;
    current = currentRecord[key];
  }
  return current;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withoutTerminalNewline(value: Uint8Array): Uint8Array {
  return value.at(-1) === 0x0a ? value.slice(0, -1) : value;
}

function expectValue(
  errors: string[],
  label: string,
  actual: unknown,
  expected: string | number | boolean,
): void {
  if (actual !== expected) errors.push(`${label} must equal ${expected}`);
}

function expectIsoDate(errors: string[], label: string, value: unknown): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO date`);
  }
}

function parseProvenance(bytes: Uint8Array, errors: string[]): unknown {
  const payload = withoutTerminalNewline(bytes);
  if (payload.byteLength !== 2058) errors.push("provenance byte length must equal 2058");
  if (sha256(payload) !== MATTERMOST_CAPABILITY_ARTIFACT.provenanceDigest) {
    errors.push("provenance sha256 does not match the registry statement digest");
  }
  try {
    return JSON.parse(Buffer.from(payload).toString("utf8")) as unknown;
  } catch {
    errors.push("provenance statement must be valid JSON");
    return null;
  }
}

function verifyProvenanceStatement(statement: unknown, errors: string[]): void {
  expectValue(errors, "provenance predicate", at(statement, "predicateType"), "https://slsa.dev/provenance/v1");
  expectValue(
    errors,
    "provenance source commit",
    at(
      statement,
      "predicate",
      "buildDefinition",
      "externalParameters",
      "request",
      "root",
      "request",
      "args",
      "vcs:revision",
    ),
    MATTERMOST_CAPABILITY_ARTIFACT.sourceCommit,
  );
  expectValue(
    errors,
    "provenance source repository",
    at(
      statement,
      "predicate",
      "buildDefinition",
      "externalParameters",
      "request",
      "root",
      "request",
      "args",
      "vcs:source",
    ),
    "https://github.com/mattermost/mattermost",
  );
  expectValue(
    errors,
    "provenance user platform",
    at(statement, "predicate", "buildDefinition", "internalParameters", "builderPlatform"),
    "linux/amd64",
  );
  const subjects = at(statement, "subject");
  const subject = Array.isArray(subjects)
    ? subjects.map(record).find((value) =>
      value?.name ===
        "pkg:docker/mattermostdevelopment/mattermost-team-edition@cce485f?platform=linux%2Famd64")
    : undefined;
  expectValue(
    errors,
    "provenance platform manifest",
    at(subject, "digest", "sha256"),
    MATTERMOST_CAPABILITY_ARTIFACT.platformManifest.slice("sha256:".length),
  );
}

function verifyArtifactEvidence(evidence: unknown, errors: string[]): void {
  expectValue(errors, "artifact repository", at(evidence, "artifact", "repository"), MATTERMOST_CAPABILITY_ARTIFACT.repository);
  expectValue(errors, "artifact tag", at(evidence, "artifact", "tag"), MATTERMOST_CAPABILITY_ARTIFACT.tag);
  expectValue(errors, "artifact index digest", at(evidence, "artifact", "indexDigest"), MATTERMOST_CAPABILITY_ARTIFACT.digest);
  expectValue(errors, "artifact platform OS", at(evidence, "artifact", "platform", "os"), "linux");
  expectValue(errors, "artifact platform architecture", at(evidence, "artifact", "platform", "architecture"), "amd64");
  expectValue(
    errors,
    "artifact platform manifest",
    at(evidence, "artifact", "platform", "manifestDigest"),
    MATTERMOST_CAPABILITY_ARTIFACT.platformManifest,
  );
  expectValue(
    errors,
    "artifact config digest",
    at(evidence, "artifact", "platform", "configDigest"),
    MATTERMOST_CAPABILITY_ARTIFACT.configDigest,
  );
  expectValue(
    errors,
    "evidence source commit",
    at(evidence, "provenance", "sourceCommit"),
    MATTERMOST_CAPABILITY_ARTIFACT.sourceCommit,
  );
  expectValue(
    errors,
    "evidence statement digest",
    at(evidence, "provenance", "statementDigest"),
    MATTERMOST_CAPABILITY_ARTIFACT.provenanceDigest,
  );
  expectValue(errors, "evidence user platform", at(evidence, "provenance", "builderPlatform"), "linux/amd64");
  expectValue(errors, "signature disposition", at(evidence, "provenance", "signatureDisposition"), "not-supplied");
}

function findingIds(evidence: unknown): { high: string[]; occurrences: number } {
  const findings = at(evidence, "vulnerabilityScan", "findings");
  if (!Array.isArray(findings)) return { high: [], occurrences: 0 };
  const high: string[] = [];
  let occurrences = 0;
  for (const value of findings) {
    const finding = record(value);
    if (!finding || finding.severity !== "HIGH" || typeof finding.id !== "string") continue;
    high.push(finding.id);
    occurrences += Array.isArray(finding.targets) ? finding.targets.length : 0;
  }
  return { high, occurrences };
}

function trivyVulnerabilities(report: unknown): Array<{ id: string; severity: string; target: string }> {
  const results = at(report, "Results");
  if (!Array.isArray(results)) return [];
  const vulnerabilities: Array<{ id: string; severity: string; target: string }> = [];
  for (const resultValue of results) {
    const result = record(resultValue);
    if (!result || typeof result.Target !== "string" || !Array.isArray(result.Vulnerabilities)) {
      continue;
    }
    for (const vulnerabilityValue of result.Vulnerabilities) {
      const vulnerability = record(vulnerabilityValue);
      if (
        vulnerability &&
        typeof vulnerability.VulnerabilityID === "string" &&
        typeof vulnerability.Severity === "string"
      ) {
        vulnerabilities.push({
          id: vulnerability.VulnerabilityID,
          severity: vulnerability.Severity,
          target: result.Target,
        });
      }
    }
  }
  return vulnerabilities;
}

function parseJsonBytes(value: Uint8Array, label: string, errors: string[]): unknown {
  try {
    return JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch {
    errors.push(`${label} must be valid JSON`);
    return null;
  }
}

function verifyTrivyReport(
  evidence: unknown,
  reportBytes: Uint8Array,
  archiveBytes: Uint8Array,
  errors: string[],
): void {
  expectValue(
    errors,
    "Trivy raw report sha256",
    sha256(reportBytes),
    String(at(evidence, "vulnerabilityScan", "rawReport", "sha256")),
  );
  expectValue(
    errors,
    "Trivy raw report byte length",
    reportBytes.byteLength,
    Number(at(evidence, "vulnerabilityScan", "rawReport", "byteLength")),
  );
  expectValue(
    errors,
    "Trivy archive sha256",
    sha256(archiveBytes),
    String(at(evidence, "vulnerabilityScan", "rawReport", "gzipSha256")),
  );
  expectValue(
    errors,
    "Trivy archive byte length",
    archiveBytes.byteLength,
    Number(at(evidence, "vulnerabilityScan", "rawReport", "gzipByteLength")),
  );
  const report = parseJsonBytes(reportBytes, "Trivy raw report", errors);
  expectValue(errors, "Trivy report artifact", at(report, "ArtifactName"), MATTERMOST_CAPABILITY_ARTIFACT.reference);
  expectValue(errors, "Trivy report architecture", at(report, "Metadata", "ImageConfig", "architecture"), "amd64");
  const repoDigests = at(report, "Metadata", "RepoDigests");
  if (
    !Array.isArray(repoDigests) ||
    !repoDigests.includes(`${MATTERMOST_CAPABILITY_ARTIFACT.repository}@${MATTERMOST_CAPABILITY_ARTIFACT.digest}`)
  ) {
    errors.push("Trivy report must identify the exact repository digest");
  }
  const vulnerabilities = trivyVulnerabilities(report);
  const high = vulnerabilities.filter(({ severity }) => severity === "HIGH");
  const critical = vulnerabilities.filter(({ severity }) => severity === "CRITICAL");
  expectValue(errors, "Trivy report HIGH count", high.length, Number(at(evidence, "vulnerabilityScan", "highCount")));
  expectValue(errors, "Trivy report CRITICAL count", critical.length, Number(at(evidence, "vulnerabilityScan", "criticalCount")));
  const normalizedFindings = at(evidence, "vulnerabilityScan", "findings");
  const expectedTargets = Array.isArray(normalizedFindings)
    ? record(normalizedFindings[0])?.targets
    : undefined;
  const actualTargets = high.map(({ target }) => target).sort();
  if (
    !Array.isArray(expectedTargets) ||
    JSON.stringify(actualTargets) !== JSON.stringify([...expectedTargets].sort()) ||
    high.some(({ id }) => id !== "CVE-2026-39822")
  ) {
    errors.push("Trivy raw findings do not match the normalized evidence");
  }
}

function verifyScanEvidence(evidence: unknown, errors: string[], now: Date): void {
  expectValue(errors, "Trivy scanner", at(evidence, "vulnerabilityScan", "scanner"), "trivy");
  expectValue(errors, "Trivy version", at(evidence, "vulnerabilityScan", "version"), "0.71.1");
  expectValue(
    errors,
    "Trivy artifact",
    at(evidence, "vulnerabilityScan", "artifactName"),
    MATTERMOST_CAPABILITY_ARTIFACT.reference,
  );
  expectValue(errors, "Trivy criticalCount", at(evidence, "vulnerabilityScan", "criticalCount"), 0);
  const highCount = at(evidence, "vulnerabilityScan", "highCount");
  const findings = findingIds(evidence);
  if (highCount !== findings.occurrences) {
    errors.push("Trivy highCount must equal the recorded finding occurrences");
  }
  const accepted = at(evidence, "vulnerabilityScan", "disposition", "acceptedFindings");
  const acceptedIds = Array.isArray(accepted)
    ? accepted.filter((value): value is string => typeof value === "string")
    : [];
  if (
    findings.high.length === 0 ||
    findings.high.some((id) => !acceptedIds.includes(id)) ||
    acceptedIds.some((id) => !findings.high.includes(id))
  ) {
    errors.push("every HIGH finding disposition must be explicit and exact");
  }
  expectValue(errors, "Trivy disposition", at(evidence, "vulnerabilityScan", "disposition", "status"), "accepted");
  const rationale = at(evidence, "vulnerabilityScan", "disposition", "rationale");
  if (typeof rationale !== "string" || rationale.length < 200) {
    errors.push("accepted Trivy findings require a substantive rationale");
  }
  expectValue(
    errors,
    "scan source reachability commit",
    at(evidence, "vulnerabilityScan", "disposition", "sourceReachability", "sourceCommit"),
    MATTERMOST_CAPABILITY_ARTIFACT.sourceCommit,
  );
  const affected = at(
    evidence,
    "vulnerabilityScan",
    "disposition",
    "sourceReachability",
    "affectedSymbolsObserved",
  );
  if (!Array.isArray(affected) || affected.length !== 0) {
    errors.push("accepted Go CVE evidence must record zero affected symbols observed");
  }
  const expiresAt = at(evidence, "vulnerabilityScan", "disposition", "expiresAt");
  expectIsoDate(errors, "Trivy disposition expiresAt", expiresAt);
  if (typeof expiresAt === "string" && Date.parse(expiresAt) <= now.getTime()) {
    errors.push("Trivy accepted finding disposition is expired");
  }
}

function verifyCandidateIsolation(evidence: unknown, errors: string[]): void {
  expectValue(
    errors,
    "candidate release class",
    at(evidence, "candidate", "releaseClass"),
    "unpublished-11.10-source-snapshot",
  );
  expectValue(errors, "candidate deployable", at(evidence, "candidate", "deployable"), false);
  const defaultEnvironments = at(evidence, "candidate", "defaultEnvironments");
  if (!Array.isArray(defaultEnvironments) || defaultEnvironments.length !== 0) {
    errors.push("candidate default environments must be empty");
  }
}

export function verifyMattermostCapabilityEvidence(
  input: MattermostCapabilityVerificationInput,
): string[] {
  const errors: string[] = [];
  const statement = parseProvenance(input.provenance, errors);
  verifyProvenanceStatement(statement, errors);
  verifyArtifactEvidence(input.evidence, errors);
  verifyTrivyReport(input.evidence, input.trivyReport, input.trivyArchive, errors);
  verifyScanEvidence(input.evidence, errors, input.now ?? new Date());
  verifyCandidateIsolation(input.evidence, errors);
  return errors;
}
