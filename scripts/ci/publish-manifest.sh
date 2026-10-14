#!/usr/bin/env bash
set -euo pipefail
MANIFEST_IMAGE="${AR_REPO}/release-digest-manifest:${SOURCE_SHA}"
MANIFEST_FILE="$RUNNER_TEMP/release-digest-manifest.json"
BASE_MANIFEST_FILE="$RUNNER_TEMP/base-release-digest-manifest.json"

manifest_digest_for_tag() {
  .github/actions/release-digest-manifest/resolve-tag-digest.sh \
    "$AR_REPO" "$GCP_PROJECT" "$1"
}

extract_manifest() {
  local image="$1" destination="$2" container
  docker pull "$image"
  container="$(docker create "$image" /bin/true)"
  docker cp "${container}:/release-digest-manifest.json" "$destination"
  docker rm "$container" >/dev/null
}

if [ -n "$BASE_SHA" ]; then
  BASE_MANIFEST_TAG="${AR_REPO}/release-digest-manifest:${BASE_SHA}"
  lookup_status=0
  base_manifest_digest="$(manifest_digest_for_tag "$BASE_MANIFEST_TAG")" || lookup_status=$?
  if [ "$lookup_status" = "0" ]; then
    extract_manifest "${AR_REPO}/release-digest-manifest@${base_manifest_digest}" "$BASE_MANIFEST_FILE"
  elif [ "$lookup_status" = "3" ]; then
    echo "::notice::confirmed absent baseline manifest for ${BASE_SHA}; this main build must provide every SHA-addressed image"
  else
    echo "::error::could not read baseline digest manifest ${BASE_MANIFEST_TAG}"
    exit "$lookup_status"
  fi
fi

OPENCLAW_OBJECT="$(node -e '
  const current = require("./infra/gateway/openclaw-tarball/current.json");
  if (typeof current.openclawObject !== "string" || current.openclawObject.length === 0) {
    throw new Error("missing current OpenClaw object");
  }
  process.stdout.write(current.openclawObject);
')"
OPENCLAW_TARBALL="$RUNNER_TEMP/openclaw-fork.tgz"
gcloud storage cp \
  "gs://octogee-openclaw-fork/${OPENCLAW_OBJECT}" \
  "$OPENCLAW_TARBALL"
OPENCLAW_RUNTIME_VERSION="$(
  tar -xzOf "$OPENCLAW_TARBALL" package/package.json \
    | node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).version)'
)"
OPENCLAW_SOURCE_SHA="$(
  tar -xzOf "$OPENCLAW_TARBALL" package/dist/build-info.json \
    | node -e 'const fs = require("node:fs"); process.stdout.write(JSON.parse(fs.readFileSync(0, "utf8")).commit)'
)"
INPUT_FILE="$RUNNER_TEMP/release-digest-main-build-input.json"
export AR_REPO SOURCE_SHA OPENCLAW_RUNTIME_VERSION OPENCLAW_SOURCE_SHA INPUT_FILE BASE_MANIFEST_FILE RUN_PLATFORM RUN_GATEWAY
python3 - <<'PYEOF'
import json
import os
import subprocess

baseline = {}
baseline_openclaw_version = None
baseline_openclaw_source_sha = None
base_path = os.environ["BASE_MANIFEST_FILE"]
if os.path.exists(base_path):
    with open(base_path) as stream:
        prior = json.load(stream)
    surfaces = prior.get("surfaces", {})
    baseline = {
        **surfaces.get("platform", {}),
        **surfaces.get("gateway", {}),
    }
    baseline_openclaw_version = prior.get("openclawVersion")
    baseline_openclaw_source_sha = prior.get("openclawSourceSha")

exact_images = {}
for image in (
    "artifact-worker", "gateway-edge", "glm-controller", "octogee-api", "octogee-project-runner",
    "octogee-gateway", "octogee-gateway-builder", "octogee-ops-agent",
):
    ref = f"{os.environ['AR_REPO']}/{image}:{os.environ['SOURCE_SHA']}"
    result = subprocess.run(
        [".github/actions/release-digest-manifest/resolve-tag-digest.sh",
         os.environ["AR_REPO"], os.environ["GCP_PROJECT"], ref],
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        exact_images[image] = result.stdout.strip()
    elif result.returncode == 3:
        continue
    else:
        raise SystemExit(f"could not resolve SHA-addressed image: {ref}: {result.stderr.strip()}")
with open(os.environ["INPUT_FILE"], "w") as stream:
    json.dump({
        "sourceSha": os.environ["SOURCE_SHA"],
        **({"sourceArchive": json.loads(os.environ["SOURCE_ARCHIVE_ARTIFACT"])}
           if os.environ.get("SOURCE_ARCHIVE_ARTIFACT") else {}),
        **({"desktopImage": json.loads(os.environ["DESKTOP_IMAGE_ARTIFACT"])}
           if os.environ["DESKTOP_IMAGE_ARTIFACT"] else {}),
        "openclawVersion": os.environ["OPENCLAW_RUNTIME_VERSION"],
        "openclawSourceSha": os.environ["OPENCLAW_SOURCE_SHA"],
        "baselineOpenclawVersion": baseline_openclaw_version,
        "baselineOpenclawSourceSha": baseline_openclaw_source_sha,
        "repository": os.environ["AR_REPO"],
        "baselineImages": baseline,
        "exactImages": exact_images,
        "changedScopes": {
            "platform": os.environ["RUN_PLATFORM"] == "true",
            "gateway": os.environ["RUN_PLATFORM"] == "true" or os.environ["RUN_GATEWAY"] == "true",
        },
    }, stream, sort_keys=True)
PYEOF
node .github/actions/release-digest-manifest/release-digest-manifest.mjs create-main-build "$INPUT_FILE" > "$MANIFEST_FILE"

lookup_status=0
manifest_digest="$(manifest_digest_for_tag "$MANIFEST_IMAGE")" || lookup_status=$?
if [ "$lookup_status" = "0" ]; then
  EXISTING_MANIFEST="$RUNNER_TEMP/existing-release-digest-manifest.json"
  extract_manifest "${AR_REPO}/release-digest-manifest@${manifest_digest}" "$EXISTING_MANIFEST"
  cmp -s "$MANIFEST_FILE" "$EXISTING_MANIFEST" || {
    echo "::error::${MANIFEST_IMAGE} already contains a different immutable manifest"
    exit 1
  }
elif [ "$lookup_status" = "3" ]; then
  MANIFEST_DIR="$RUNNER_TEMP/release-digest-manifest"
  mkdir -p "$MANIFEST_DIR"
  cp "$MANIFEST_FILE" "$MANIFEST_DIR/release-digest-manifest.json"
  printf 'FROM scratch\nCOPY release-digest-manifest.json /release-digest-manifest.json\n' > "$MANIFEST_DIR/Dockerfile"
  docker build --tag "$MANIFEST_IMAGE" "$MANIFEST_DIR"
  docker push "$MANIFEST_IMAGE"

  lookup_status=0
  manifest_digest="$(manifest_digest_for_tag "$MANIFEST_IMAGE")" || lookup_status=$?
  if [ "$lookup_status" != "0" ]; then
    echo "::error::could not resolve ${MANIFEST_IMAGE} after writing immutable manifest"
    exit "$lookup_status"
  fi
  EXISTING_MANIFEST="$RUNNER_TEMP/written-release-digest-manifest.json"
  extract_manifest "${AR_REPO}/release-digest-manifest@${manifest_digest}" "$EXISTING_MANIFEST"
  cmp -s "$MANIFEST_FILE" "$EXISTING_MANIFEST" || {
    echo "::error::${MANIFEST_IMAGE} changed after writing immutable manifest"
    exit 1
  }
else
  echo "::error::could not resolve ${MANIFEST_IMAGE}"
  exit "$lookup_status"
fi

echo "manifest_digest=${manifest_digest}" >> "$CI_OUTPUT_FILE"
