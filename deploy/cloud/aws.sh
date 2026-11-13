#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

PROVIDER="aws"
NODE_TYPE="${NODE_TYPE:-m6i.xlarge}"
DB_CLASS="${DB_CLASS:-db.m6i.large}"
DB_INSTANCE="${CLUSTER_NAME}"
FILES_USER="${CLUSTER_NAME}-files"

a() {
  aws --region "${AWS_REGION}" "$@"
}

create_cluster() {
  step "EKS cluster (about 20 minutes)"
  eksctl create cluster --write-kubeconfig=false -f - <<YAML
apiVersion: eksctl.io/v1alpha5
kind: ClusterConfig
metadata:
  name: ${CLUSTER_NAME}
  region: ${AWS_REGION}
iam:
  withOIDC: true
addons:
  - name: aws-ebs-csi-driver
    wellKnownPolicies:
      ebsCSIController: true
managedNodeGroups:
  - name: default
    instanceType: ${NODE_TYPE}
    minSize: 2
    desiredCapacity: 3
    maxSize: 5
    volumeSize: 100
    privateNetworking: true
YAML
}

apply_default_storage_class() {
  kubectl --context "${KUBE_CONTEXT}" apply -f - >/dev/null <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
allowVolumeExpansion: true
parameters:
  type: gp3
  encrypted: "true"
YAML
}

ensure_cluster() {
  a eks describe-cluster --name "${CLUSTER_NAME}" >/dev/null 2>&1 || create_cluster
  a eks update-kubeconfig --name "${CLUSTER_NAME}" --kubeconfig "${KUBECONFIG}" >/dev/null
  KUBE_CONTEXT="$(kubectl config current-context)"
  apply_default_storage_class
}

cluster_field() {
  a eks describe-cluster --name "${CLUSTER_NAME}" --query "cluster.resourcesVpcConfig.${1}" --output text
}

ensure_database_security_group() {
  local vpc_id
  vpc_id="$(cluster_field vpcId)"
  DB_SECURITY_GROUP="$(a ec2 describe-security-groups \
    --filters "Name=vpc-id,Values=${vpc_id}" "Name=group-name,Values=${CLUSTER_NAME}-database" \
    --query 'SecurityGroups[0].GroupId' --output text)"
  if [ "${DB_SECURITY_GROUP}" = "None" ] || [ -z "${DB_SECURITY_GROUP}" ]; then
    DB_SECURITY_GROUP="$(a ec2 create-security-group --group-name "${CLUSTER_NAME}-database" \
      --description "PostgreSQL from the cluster" --vpc-id "${vpc_id}" --query GroupId --output text)"
    a ec2 authorize-security-group-ingress --group-id "${DB_SECURITY_GROUP}" --protocol tcp --port 5432 \
      --source-group "$(cluster_field clusterSecurityGroupId)" >/dev/null
  fi
}

ensure_database_subnets() {
  a rds describe-db-subnet-groups --db-subnet-group-name "${CLUSTER_NAME}" >/dev/null 2>&1 && return 0
  local subnets
  subnets="$(a ec2 describe-subnets \
    --filters "Name=vpc-id,Values=$(cluster_field vpcId)" "Name=tag:kubernetes.io/role/internal-elb,Values=1" \
    --query 'Subnets[].SubnetId' --output text)"
  [ -n "${subnets}" ] || die "no private subnets found for ${CLUSTER_NAME}"
  a rds create-db-subnet-group --db-subnet-group-name "${CLUSTER_NAME}" \
    --db-subnet-group-description "PostgreSQL for ${CLUSTER_NAME}" --subnet-ids ${subnets} >/dev/null
}

ensure_database() {
  if ! a rds describe-db-instances --db-instance-identifier "${DB_INSTANCE}" >/dev/null 2>&1; then
    step "RDS for PostgreSQL 16 (about 20 minutes)"
    ensure_database_security_group
    ensure_database_subnets
    a rds create-db-instance --db-instance-identifier "${DB_INSTANCE}" --engine postgres \
      --engine-version 16 --db-instance-class "${DB_CLASS}" --allocated-storage 50 --storage-type gp3 \
      --master-username postgres --master-user-password "$(secret_value platform-credentials postgres-password)" \
      --db-subnet-group-name "${CLUSTER_NAME}" --vpc-security-group-ids "${DB_SECURITY_GROUP}" \
      --multi-az --storage-encrypted --no-publicly-accessible \
      --backup-retention-period 7 --deletion-protection >/dev/null
  fi
  a rds wait db-instance-available --db-instance-identifier "${DB_INSTANCE}"
  DB_HOST="$(a rds describe-db-instances --db-instance-identifier "${DB_INSTANCE}" \
    --query 'DBInstances[0].Endpoint.Address' --output text)"
  [ -n "${DB_HOST}" ] || die "RDS did not report an address for ${DB_INSTANCE}"
}

create_bucket() {
  if [ "${AWS_REGION}" = "us-east-1" ]; then
    a s3api create-bucket --bucket "${BUCKET_NAME}" >/dev/null
  else
    a s3api create-bucket --bucket "${BUCKET_NAME}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}" >/dev/null
  fi
}

ensure_bucket() {
  step "S3 bucket"
  BUCKET_NAME="${CLUSTER_NAME}-$(a sts get-caller-identity --query Account --output text)"
  a s3api head-bucket --bucket "${BUCKET_NAME}" >/dev/null 2>&1 || create_bucket
  k get secret object-store >/dev/null 2>&1 && return 0
  a iam get-user --user-name "${FILES_USER}" >/dev/null 2>&1 \
    || a iam create-user --user-name "${FILES_USER}" >/dev/null
  a iam put-user-policy --user-name "${FILES_USER}" --policy-name bucket --policy-document \
    "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:*\",\"Resource\":[\"arn:aws:s3:::${BUCKET_NAME}\",\"arn:aws:s3:::${BUCKET_NAME}/*\"]}]}" >/dev/null
  local keys
  keys="$(a iam create-access-key --user-name "${FILES_USER}" \
    --query '[AccessKey.AccessKeyId,AccessKey.SecretAccessKey]' --output text)"
  [ -n "${keys}" ] || die "IAM did not return an access key"
  write_object_store "https://s3.${AWS_REGION}.amazonaws.com" "${BUCKET_NAME}" "${AWS_REGION}" \
    "$(printf '%s' "${keys}" | cut -f1)" "$(printf '%s' "${keys}" | cut -f2)"
}

main() {
  require_tools aws eksctl kubectl helm openssl curl base64
  require_settings AWS_REGION DOMAIN ACME_EMAIL
  use_dedicated_kubeconfig "${PROVIDER}"
  load_public_hosts
  ensure_cluster
  ensure_namespace
  ensure_credentials
  ensure_database
  ensure_bucket
  apply_settings
  apply_model_keys
  prepare_databases
  install_on_cluster --set-string 'service.annotations.service\.beta\.kubernetes\.io/aws-load-balancer-type=nlb'
}

main "$@"
