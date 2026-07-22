#!/usr/bin/env bash

octogee_load_deployment_target() {
  if [ "$#" -ne 1 ]; then
    echo "octogee_load_deployment_target requires one --environment= or --target= selector" >&2
    return 2
  fi

  local helper_dir repo_root output key value
  helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$helper_dir/../.." && pwd)"
  if ! output="$(node "$repo_root/core/dist/resolve-deployment-target.js" "$1")"; then
    return 1
  fi

  while IFS='=' read -r key value; do
    case "$key" in
      environment) TARGET_ENVIRONMENT="$value" ;;
      target_id) TARGET_ID="$value" ;;
      lifecycle) TARGET_LIFECYCLE="$value" ;;
      cluster_project_id) TARGET_CLUSTER_PROJECT="$value" ;;
      firebase_project_id) TARGET_FIREBASE_PROJECT="$value" ;;
      hosting_project_id) TARGET_HOSTING_PROJECT="$value" ;;
      region) TARGET_REGION="$value" ;;
      cluster_name) TARGET_CLUSTER_NAME="$value" ;;
      kube_context) TARGET_KUBE_CONTEXT="$value" ;;
      namespace) TARGET_NAMESPACE="$value" ;;
      artifact_registry_project_id) TARGET_AR_PROJECT="$value" ;;
      artifact_registry_location) TARGET_AR_LOCATION="$value" ;;
      artifact_registry_name) TARGET_AR_NAME="$value" ;;
      artifact_registry_repository) TARGET_AR_REPOSITORY="$value" ;;
      cloud_sql_project_id) TARGET_CLOUD_SQL_PROJECT="$value" ;;
      cloud_sql_region) TARGET_CLOUD_SQL_REGION="$value" ;;
      cloud_sql_instance_name) TARGET_CLOUD_SQL_INSTANCE="$value" ;;
      cloud_sql_connection_name) TARGET_CLOUD_SQL_CONNECTION="$value" ;;
      cloud_sql_point_in_time_recovery_enabled) TARGET_CLOUD_SQL_PITR_ENABLED="$value" ;;
      kms_project_id) TARGET_KMS_PROJECT="$value" ;;
      kms_location) TARGET_KMS_LOCATION="$value" ;;
      kms_key_name) TARGET_KMS_KEY_NAME="$value" ;;
      storage_project_id) TARGET_STORAGE_PROJECT="$value" ;;
      storage_location) TARGET_STORAGE_LOCATION="$value" ;;
      site_origin) TARGET_SITE_ORIGIN="$value" ;;
      app_origin) TARGET_APP_ORIGIN="$value" ;;
      api_origin) TARGET_API_ORIGIN="$value" ;;
      git_origin) TARGET_GIT_ORIGIN="$value" ;;
      mattermost_origin) TARGET_MATTERMOST_ORIGIN="$value" ;;
      preview_origin) TARGET_PREVIEW_ORIGIN="$value" ;;
      gateway_values_file) TARGET_GATEWAY_VALUES_FILE="$value" ;;
      compute_class) TARGET_COMPUTE_CLASS="$value" ;;
      pin_environment) TARGET_PIN_ENVIRONMENT="$value" ;;
    esac
  done <<< "$output"

  export TARGET_ENVIRONMENT TARGET_ID TARGET_LIFECYCLE
  export TARGET_CLUSTER_PROJECT TARGET_FIREBASE_PROJECT TARGET_HOSTING_PROJECT
  export TARGET_REGION TARGET_CLUSTER_NAME TARGET_KUBE_CONTEXT TARGET_NAMESPACE
  export TARGET_AR_PROJECT TARGET_AR_LOCATION TARGET_AR_NAME TARGET_AR_REPOSITORY
  export TARGET_CLOUD_SQL_PROJECT TARGET_CLOUD_SQL_REGION
  export TARGET_CLOUD_SQL_INSTANCE TARGET_CLOUD_SQL_CONNECTION TARGET_CLOUD_SQL_PITR_ENABLED
  export TARGET_KMS_PROJECT TARGET_KMS_LOCATION TARGET_KMS_KEY_NAME
  export TARGET_STORAGE_PROJECT TARGET_STORAGE_LOCATION
  export TARGET_SITE_ORIGIN TARGET_APP_ORIGIN TARGET_API_ORIGIN
  export TARGET_GIT_ORIGIN TARGET_MATTERMOST_ORIGIN TARGET_PREVIEW_ORIGIN
  export TARGET_GATEWAY_VALUES_FILE TARGET_COMPUTE_CLASS TARGET_PIN_ENVIRONMENT
}
