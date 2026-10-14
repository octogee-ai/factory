#!/usr/bin/env bash
set -euo pipefail
case "${1:?check name required}" in
  eslint)
    node scripts/ds-tokens.mjs
    npm run lint -- --format=stylish --max-warnings=0
    ;;
  knip)
    while IFS= read -r workspace; do
      if [ -f "$workspace/package-lock.json" ]; then npm ci --prefix "$workspace" --no-audit --no-fund; fi
    done < <(jq -r '.workspaces | keys[] | select(. != ".")' knip.json)
    npm run knip -- --reporter compact
    ;;
  gitleaks)
    gitleaks detect --config=.gitleaks.toml --source=. \
      --log-opts="${CI_BASE_SHA:?base SHA required}..${CI_HEAD_SHA:?head SHA required}" --redact --verbose --exit-code=1
    if [ "${CI_INCLUDE_WORKING_TREE:-false}" = true ]; then node scripts/ci/working-tree-scan.mjs; fi
    ;;
  osv-scanner)
    args=(--config=osv-scanner.toml)
    while IFS= read -r lockfile; do args+=("--lockfile=$lockfile"); done < <(git ls-files '*package-lock.json')
    [ "${#args[@]}" -gt 1 ] || { echo 'No tracked lockfiles found' >&2; exit 1; }
    osv-scanner scan source "${args[@]}"
    ;;
  trivy)
    args=(config . --skip-dirs '**/node_modules' --skip-dirs '**/dist' --skip-dirs '.claude/worktrees' --skip-dirs '**/.astro' --skip-dirs 'tests/fixtures')
    trivy "${args[@]}" --severity CRITICAL,HIGH,MEDIUM --exit-code 0
    trivy "${args[@]}" --severity CRITICAL --exit-code 1
    ;;
  cargo-audit) (cd artifact-worker/renderer && cargo-audit audit) ;;
  *) echo "Unknown quality check: $1" >&2; exit 2 ;;
esac
