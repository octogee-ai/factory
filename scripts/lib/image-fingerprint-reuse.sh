#!/usr/bin/env bash
#
# image-fingerprint-reuse.sh — per-image build-input fingerprint reuse for
# CI's platform/gateway image builds.
#
# The input-set definitions (which directories/files each image's build
# truly depends on) live in
# .github/actions/build-image-fingerprint/image-fingerprint.mjs — this
# script is CI glue around that pure logic: it resolves the fingerprint,
# does the Artifact Registry lookup/tag, and enforces fail-closed collision
# semantics. It never decides WHAT belongs in an image's input set.
#
# Usage:
#   image-fingerprint-reuse.sh check  <image> <ar-repo> <short-sha> <ref> [base-tag]
#   image-fingerprint-reuse.sh record <image> <ar-repo> <short-sha> <fingerprint>
#
# <base-tag> is required for images built over a pre-built base (the gateway
# pod image and its operator variant): it salts the fingerprint so a base
# refresh — including the operator base's weekly toolkit slot — is never
# reused across.
#
# `check` is called only after the caller has already confirmed
# <ar-repo>/<image>:<short-sha> does not exist (that fast path — including
# force_rebuild — stays in the calling workflow step). It prints two
# GITHUB_OUTPUT-format lines to stdout:
#   fingerprint=<hash-or-empty>
#   exists=true|false
# All human-readable/log/`::warning::` output goes to stderr, so a caller
# can safely do `... | tee -a "$GITHUB_OUTPUT"` or capture stdout directly.
# On a cache hit it aliases <ar-repo>/<image>:<short-sha> to the existing
# if-<hash> digest before printing exists=true. Any failure along the way
# Fingerprint computation or a missing cached tag falls back to exists=false.
# An ambiguous cached lookup or target-tag write fails closed because release
# tags are immutable.
#
# `record` runs after a real build+push, tagging the just-pushed
# <ar-repo>/<image>:<short-sha> digest with if-<fingerprint> so a future
# `check` can find it. If if-<fingerprint> already points at a DIFFERENT
# digest than what this build just produced, it fails closed (exit 2) —
# that means either the declared input set is missing a real build input,
# or the build isn't reproducible from identical declared inputs.
#
# Exit codes:
#   0  success (including "fell back to building" outcomes)
#   1  bad invocation
#   2  immutable tag collision or ambiguous tag state — fail closed
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
FINGERPRINT_SCRIPT="$REPO_ROOT/.github/actions/build-image-fingerprint/image-fingerprint.mjs"
TAG_DIGEST_RESOLVER="$REPO_ROOT/.github/actions/release-digest-manifest/resolve-tag-digest.sh"

resolve_tag_digest() {
  local registry_suffix="${1#*-docker.pkg.dev/}"
  "$TAG_DIGEST_RESOLVER" "$1" "${registry_suffix%%/*}" "$2"
}

create_immutable_tag() {
  local ar_repo="$1" image="$2" tag="$3" intended_digest="$4"
  local registry_suffix location registry_project repository_name reference observed create_error lookup_status
  registry_suffix="${ar_repo#*-docker.pkg.dev/}"
  location="${ar_repo%%-docker.pkg.dev/*}"
  registry_project="${registry_suffix%%/*}"
  repository_name="${registry_suffix#*/}"
  reference="${ar_repo}/${image}:${tag}"

  lookup_status=0
  observed="$(resolve_tag_digest "$ar_repo" "$reference")" || lookup_status=$?
  if [ "$lookup_status" = "0" ]; then
    if [ "$observed" != "$intended_digest" ]; then
      echo "immutable tag collision: ${reference} is ${observed}, expected ${intended_digest}" >&2
      return 2
    fi
    return 0
  fi
  if [ "$lookup_status" != "3" ]; then
    echo "could not establish absence of ${reference}; refusing to create it" >&2
    return 2
  fi

  create_error="$(mktemp)"
  if ! gcloud artifacts tags create "$tag" \
    --location="$location" \
    --repository="$repository_name" \
    --package="$image" \
    --version="$intended_digest" \
    --project="$registry_project" --quiet 2>"$create_error"; then
    lookup_status=0
    observed="$(resolve_tag_digest "$ar_repo" "$reference")" || lookup_status=$?
    if [ "$lookup_status" = "0" ] && [ "$observed" != "$intended_digest" ]; then
      cat "$create_error" >&2
      rm -f "$create_error"
      echo "immutable tag collision: ${reference} is ${observed}, expected ${intended_digest}" >&2
      return 2
    fi
    if [ "$lookup_status" != "0" ]; then
      cat "$create_error" >&2
      rm -f "$create_error"
      echo "could not create immutable tag ${reference}" >&2
      return 1
    fi
  fi
  rm -f "$create_error"
}

usage() {
  echo "usage: image-fingerprint-reuse.sh check <image> <ar-repo> <short-sha> <ref> | record <image> <ar-repo> <short-sha> <fingerprint>" >&2
  exit 1
}

mode="${1:-}"

case "$mode" in
  check)
    image="${2:?image required}"
    ar_repo="${3:?ar-repo required}"
    short_sha="${4:?short-sha required}"
    ref="${5:?ref required}"
    base_tag="${6:-}"

    fingerprint=""
    fp_err="$(mktemp)"
    trap 'rm -f "$fp_err"' EXIT
    if fingerprint="$(node "$FINGERPRINT_SCRIPT" fingerprint "$image" "$ref" "$base_tag" 2>"$fp_err")"; then
      :
    else
      echo "::warning::input fingerprint computation failed for ${image}: $(cat "$fp_err" 2>/dev/null); falling back to build" >&2
      fingerprint=""
    fi
    printf 'fingerprint=%s\n' "$fingerprint"

    if [ -z "$fingerprint" ]; then
      printf 'exists=false\n'
      exit 0
    fi

    if_ref="${ar_repo}/${image}:if-${fingerprint}"
    target_ref="${ar_repo}/${image}:${short_sha}"

    # Capture the digest from the same describe call we'd make anyway (no
    # extra AR read) so a reuse hit can name it in the notice below.
    digest=""
    lookup_status=0
    digest="$(resolve_tag_digest "$ar_repo" "$if_ref")" || lookup_status=$?
    if [ "$lookup_status" = "3" ]; then
      echo "no cached ${image} image for input fingerprint if-${fingerprint}; will build" >&2
      printf 'exists=false\n'
      exit 0
    fi
    if [ "$lookup_status" != "0" ]; then
      echo "::warning::could not resolve ${if_ref}; falling back to build" >&2
      printf 'exists=false\n'
      exit 0
    fi

    alias_status=0
    create_immutable_tag "$ar_repo" "$image" "$short_sha" "$digest" || alias_status=$?
    if [ "$alias_status" = "0" ]; then
      # The reused container's own BUILD_SHA env var still reports whichever
      # commit originally produced these bytes (#1116) — that's honest, but
      # it can read as stale/confusing next to the ${short_sha} AR tag now
      # pointing at it. Surface both identifiers explicitly rather than
      # rebuilding just to refresh a banner string.
      echo "::notice::reused ${image} — Artifact Registry digest ${digest} (input fingerprint if-${fingerprint}) already held these bytes; the running container's BUILD_SHA identifies the commit that originally built it, ${short_sha} is only this build's AR tag" >&2
      echo "reused ${image} from unchanged inputs (if-${fingerprint})" >&2
      printf 'exists=true\n'
    else
      echo "failed to create immutable alias ${target_ref} from ${if_ref}" >&2
      exit 2
    fi
    ;;

  record)
    image="${2:?image required}"
    ar_repo="${3:?ar-repo required}"
    short_sha="${4:?short-sha required}"
    fingerprint="${5:?fingerprint required}"

    src_ref="${ar_repo}/${image}:${short_sha}"
    if_ref="${ar_repo}/${image}:if-${fingerprint}"

    # record is best-effort: the image is already built and pushed under
    # $src_ref by the time this runs, so a transient AR read/write failure
    # here must never fail the job. Worst case, the if-tag never gets
    # written and a future build with identical inputs just rebuilds.
    new_digest=""
    source_status=0
    new_digest="$(resolve_tag_digest "$ar_repo" "$src_ref")" || source_status=$?
    if [ "$source_status" != "0" ]; then
      echo "::warning::could not resolve digest for ${src_ref} after build; skipping fingerprint record (a future build will just rebuild)" >&2
      exit 0
    fi

    existing_digest=""
    lookup_status=0
    existing_digest="$(resolve_tag_digest "$ar_repo" "$if_ref")" || lookup_status=$?
    if [ "$lookup_status" != "0" ] && [ "$lookup_status" != "3" ]; then
      echo "::warning::could not resolve ${if_ref}; skipping fingerprint record" >&2
      exit 0
    fi
    if [ "$lookup_status" = "3" ]; then
      existing_digest=""
    fi

    if ! node "$FINGERPRINT_SCRIPT" assert-no-collision "$image" "if-${fingerprint}" "$existing_digest" "$new_digest"; then
      exit 2
    fi

    if [ -z "$existing_digest" ]; then
      create_status=0
      create_immutable_tag "$ar_repo" "$image" "if-${fingerprint}" "$new_digest" || create_status=$?
      if [ "$create_status" = "2" ]; then
        exit 2
      fi
      if [ "$create_status" != "0" ]; then
        echo "::warning::failed to create ${if_ref}; skipping fingerprint record" >&2
        exit 0
      fi
      echo "recorded ${if_ref} -> ${new_digest}" >&2
    else
      echo "${if_ref} already recorded with matching digest" >&2
    fi
    ;;

  *)
    usage
    ;;
esac
