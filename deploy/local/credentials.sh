#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/env.sh"

require_tools kind kubectl base64
require_cluster
username="$(secret_value platform-credentials username)"
password="$(secret_value platform-credentials password)"
gateway_token="$(secret_value platform-credentials gateway-token)"
echo "Username:      ${username}"
echo "Password:      ${password}"
echo "Gateway token: ${gateway_token}"
