#!/usr/bin/env bash
set -euo pipefail
check=${1:?audit check required}
case "$check" in
  gitleaks) gitleaks detect --config=.gitleaks.toml --source=. --redact --verbose --exit-code=1 ;;
  trivy-images)
    gcloud auth configure-docker us-central1-docker.pkg.dev --quiet
    refs=
    for name in octogee octogee-ssr-test octogee-ssr-prod; do
      repository="us-central1-docker.pkg.dev/octogee/$name"
      selected=$(gcloud artifacts docker images list "$repository" --format=json | jq -r --arg cache_prefix "$repository/cache/" -f .github/scripts/select-trivy-image-refs.jq)
      if [ -n "$selected" ]; then refs+="${refs:+$'\n'}$selected"; fi
    done
    test -n "$refs" || { echo 'Image scan coverage is empty' >&2; exit 1; }
    failures=0
    while IFS= read -r image; do
      trivy image --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --no-progress --exit-code 1 "$image" || failures=$((failures + 1))
    done <<< "$refs"
    test "$failures" -eq 0
    ;;
  osv-scanner|cargo-audit|trivy) bash platform/scripts/ci/quality.sh "$check" ;;
  *) echo "Unknown scheduled audit $check" >&2; exit 2 ;;
esac
