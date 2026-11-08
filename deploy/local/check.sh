#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"
source "${DEPLOY_DIR}/checks.sh"

require_tools kind kubectl curl
require_cluster
run_checks
