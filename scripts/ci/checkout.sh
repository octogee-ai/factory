#!/usr/bin/env bash
set -euo pipefail
[[ "${CI_SOURCE_SHA:?source SHA required}" =~ ^[a-f0-9]{40}$ ]]
export GIT_CONFIG_COUNT=2
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0="!bash $(pwd)/scripts/ci/git-credential.sh"
export GIT_CONFIG_KEY_1=safe.directory
export GIT_CONFIG_VALUE_1="$(pwd)"
if [ ! -d .git ]; then git init; fi
if ! git remote get-url origin >/dev/null 2>&1; then git remote add origin https://github.com/octogee-ai/octogee.git; fi
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --quiet --no-tags --unshallow origin
fi
git fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main "$CI_SOURCE_SHA"
git reset --mixed "$CI_SOURCE_SHA"
git diff --exit-code HEAD
test "$(git rev-parse HEAD)" = "$CI_SOURCE_SHA"
