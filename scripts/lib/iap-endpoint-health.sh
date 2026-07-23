#!/usr/bin/env bash

is_iap_protected_admin_host() {
  case "$1" in
    git.octogee.com|git-test.octogee.com|mattermost.octogee.com|mattermost-test.octogee.com)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_expected_iap_redirect() {
  [[ "$1" == "302" && "$2" == *"accounts.google.com"* ]]
}
