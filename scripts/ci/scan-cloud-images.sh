#!/usr/bin/env bash
set -euo pipefail

manifest="${1:?image manifest required}"
source_sha="${2:?source commit required}"
platform="${3:?platform required}"
reports="${4:?report directory required}"
registry=ghcr.io/octogee-ai/octogee-cloud

targets="$(node --input-type=module - "$manifest" "$source_sha" "$platform" "$registry" <<'JS'
import { readFileSync } from "node:fs";
import { PLATFORMS, PLATFORM_IMAGES } from "./scripts/ci/cloud-build.mjs";

const [file, sha, platform, registry] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(file, "utf8"));
if (!/^[a-f0-9]{40}$/.test(sha) || manifest?.sha !== sha || manifest.registry !== registry) {
  throw new Error(`Image manifest does not match ${registry} at ${sha}`);
}
if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
for (const name of PLATFORM_IMAGES) {
  const digest = manifest.images?.[name]?.platforms?.[platform];
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Image manifest: ${name} has no valid ${platform} digest`);
  }
  console.log(`${name}\t${registry}/${name}@${digest}`);
}
JS
)"

mkdir -p "$reports"
cp "$manifest" "$reports/image-manifest.json"
{
  printf '### Trivy vulnerability report for %s\n\n' "$platform"
  printf 'Source commit %s. Findings are report-only.\n\n' "$source_sha"
  printf '| Image digest | Critical | High | Medium | Low | Unknown |\n'
  printf '| --- | ---: | ---: | ---: | ---: | ---: |\n'
} >> "$GITHUB_STEP_SUMMARY"

failed=0
while IFS=$'\t' read -r name reference; do
  report="$reports/$name.trivy.json"
  if ! trivy image --image-src remote --platform "$platform" --scanners vuln --pkg-types os,library \
    --exit-code 0 --no-progress --timeout 12m --list-all-pkgs --format json --output "$report" "$reference" ||
    ! trivy convert --format cyclonedx --output "$reports/$name.cdx.json" "$report"; then
    echo "::error::Trivy could not finish reports for $reference ($platform)"
    failed=1
    continue
  fi
  jq -er --arg reference "$reference" '
    [.Results[]?.Vulnerabilities[]?.Severity] as $severities |
    ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] |
    map(. as $severity | [$severities[] | select(. == $severity)] | length) |
    "| `\($reference)` | \(map(tostring) | join(" | ")) |"
  ' "$report" >> "$GITHUB_STEP_SUMMARY"
done <<< "$targets"
exit "$failed"
