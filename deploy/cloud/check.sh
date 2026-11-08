#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
source "${DEPLOY_DIR}/checks.sh"

open_installed_cluster "${1:-}"
run_checks
