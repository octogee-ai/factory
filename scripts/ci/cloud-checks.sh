#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -gt 0 ]; then exec node platform/scripts/ci/check-lane.mjs "$1"; fi
test "${CI_BASE_BRANCH:?base branch required}" = main
if [ "${CI_CHECKOUT_READY:-false}" != true ]; then bash platform/scripts/ci/checkout.sh; fi
git submodule update --init --recursive
npm ci --prefix platform/scripts --no-audit --no-fund
platform/scripts/node_modules/.bin/tsx platform/scripts/ops/ci-checks.ts --base=origin/main --head="$CI_SOURCE_SHA" --lane="${CI_CHECK_LANE:-all}" --concurrent-lanes=5
