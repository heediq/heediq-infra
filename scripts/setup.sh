#!/usr/bin/env bash
set -euo pipefail

# =============================================================
# Heediq AWS Initial Setup (D-036, D-043, D-044, D-045)
#
# One-time script covering all AWS setup before first CI deploy:
#   1. CDK bootstrap — all accounts, required regions
#   2. OIDC providers — all accounts
#   3. IAM roles — GitHubActionsDeployRole + GitHubActionsECRRole
#
# Idempotent — safe to re-run (bootstrap is a no-op if current,
# roles are updated in-place if they already exist).
#
# Prerequisites:
#   AWS CLI with SSO profiles configured (run setup-claude.sh first):
#     aws sso login --profile heediq-shared
#     aws sso login --profile heediq-dev
#     aws sso login --profile heediq-staging
#     aws sso login --profile heediq-prod
#
# Usage (run from any directory):
#   bash heediq-infra/scripts/setup.sh
# =============================================================

# Run from repo root so pnpm cdk commands resolve correctly
cd "$(dirname "$0")/.."

# ---- config --------------------------------------------------

GITHUB_ORG="heediq"
INFRA_REPO="heediq-infra"
REGION="eu-west-1"
OIDC_HOST="token.actions.githubusercontent.com"
OIDC_THUMBPRINT="6938fd4d98bab03faadb97b34396831e3780aea1"

SHARED_ACCOUNT="313828097088"
DEV_ACCOUNT="276594885933"
STAGING_ACCOUNT="475790160542"
PROD_ACCOUNT="438825592314"

SHARED_PROFILE="heediq-shared"
DEV_PROFILE="heediq-dev"
STAGING_PROFILE="heediq-staging"
PROD_PROFILE="heediq-prod"

# ---- helpers -------------------------------------------------

verify_auth() {
  local profile=$1 expected_account=$2
  local actual
  actual=$(aws sts get-caller-identity --profile "$profile" \
    --query Account --output text 2>/dev/null) || {
    echo "  [FAIL] Auth failed — run: aws sso login --profile ${profile}"
    return 1
  }
  if [[ "$actual" != "$expected_account" ]]; then
    echo "  [FAIL] Profile ${profile} authenticated to ${actual}, expected ${expected_account}"
    return 1
  fi
}

bootstrap_account() {
  local profile=$1 account_id=$2 region=$3 env_ctx=$4
  echo "  bootstrapping aws://${account_id}/${region} ..."
  pnpm cdk bootstrap "aws://${account_id}/${region}" \
    --profile "$profile" \
    -c "env=${env_ctx}" \
    --quiet
  echo "  [ok]   aws://${account_id}/${region} bootstrapped"
}

ensure_oidc_provider() {
  local profile=$1 account_id=$2
  local arn="arn:aws:iam::${account_id}:oidc-provider/${OIDC_HOST}"
  if aws iam get-open-id-connect-provider \
      --open-id-connect-provider-arn "$arn" \
      --profile "$profile" &>/dev/null; then
    echo "  [skip] OIDC provider already exists"
  else
    aws iam create-open-id-connect-provider \
      --url "https://${OIDC_HOST}" \
      --client-id-list sts.amazonaws.com \
      --thumbprint-list "$OIDC_THUMBPRINT" \
      --profile "$profile" >/dev/null
    echo "  [ok]   OIDC provider created"
  fi
}

ensure_deploy_role() {
  local profile=$1 account_id=$2
  local role="GitHubActionsDeployRole"
  local trust
  trust=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::${account_id}:oidc-provider/${OIDC_HOST}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "${OIDC_HOST}:aud": "sts.amazonaws.com" },
      "StringLike":   { "${OIDC_HOST}:sub": "repo:${GITHUB_ORG}/${INFRA_REPO}:*" }
    }
  }]
}
EOF
)
  if aws iam get-role --role-name "$role" --profile "$profile" &>/dev/null; then
    aws iam update-assume-role-policy \
      --role-name "$role" --policy-document "$trust" --profile "$profile"
    echo "  [ok]   ${role} trust policy updated"
  else
    aws iam create-role \
      --role-name "$role" \
      --assume-role-policy-document "$trust" \
      --description "GitHub Actions CDK deploy — ${GITHUB_ORG}/${INFRA_REPO}" \
      --profile "$profile" >/dev/null
    aws iam attach-role-policy \
      --role-name "$role" \
      --policy-arn arn:aws:iam::aws:policy/AdministratorAccess \
      --profile "$profile"
    echo "  [ok]   ${role} created"
  fi
}

ensure_ecr_role() {
  local profile=$1 account_id=$2
  local role="GitHubActionsECRRole"
  local trust
  trust=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::${account_id}:oidc-provider/${OIDC_HOST}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "${OIDC_HOST}:aud": "sts.amazonaws.com" },
      "StringLike":   { "${OIDC_HOST}:sub": "repo:${GITHUB_ORG}/*:*" }
    }
  }]
}
EOF
)
  local ecr_policy
  ecr_policy=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:DescribeRepositories"
      ],
      "Resource": "arn:aws:ecr:${REGION}:${account_id}:repository/heediq-*"
    }
  ]
}
EOF
)
  if aws iam get-role --role-name "$role" --profile "$profile" &>/dev/null; then
    aws iam update-assume-role-policy \
      --role-name "$role" --policy-document "$trust" --profile "$profile"
    echo "  [ok]   ${role} trust policy updated"
  else
    aws iam create-role \
      --role-name "$role" \
      --assume-role-policy-document "$trust" \
      --description "GitHub Actions ECR push — any heediq repo" \
      --profile "$profile" >/dev/null
    aws iam put-role-policy \
      --role-name "$role" \
      --policy-name "HeediqECRPushPolicy" \
      --policy-document "$ecr_policy" \
      --profile "$profile"
    echo "  [ok]   ${role} created"
  fi
}

# ---- main ----------------------------------------------------

echo ""
echo "=== Heediq AWS Initial Setup ==="
echo ""

echo "--- 1. CDK Bootstrap ---"
echo ""

echo "1a  shared-services eu-west-1 (${SHARED_ACCOUNT})"
verify_auth "$SHARED_PROFILE" "$SHARED_ACCOUNT"
bootstrap_account "$SHARED_PROFILE" "$SHARED_ACCOUNT" "eu-west-1" "shared"

echo "1b  shared-services us-east-1 (${SHARED_ACCOUNT}) — CloudFront cert region"
bootstrap_account "$SHARED_PROFILE" "$SHARED_ACCOUNT" "us-east-1" "shared"

echo "1c  dev (${DEV_ACCOUNT})"
verify_auth "$DEV_PROFILE" "$DEV_ACCOUNT"
bootstrap_account "$DEV_PROFILE" "$DEV_ACCOUNT" "eu-west-1" "dev"

echo "1d  staging (${STAGING_ACCOUNT})"
verify_auth "$STAGING_PROFILE" "$STAGING_ACCOUNT"
bootstrap_account "$STAGING_PROFILE" "$STAGING_ACCOUNT" "eu-west-1" "dev"

echo "1e  prod (${PROD_ACCOUNT})"
verify_auth "$PROD_PROFILE" "$PROD_ACCOUNT"
bootstrap_account "$PROD_PROFILE" "$PROD_ACCOUNT" "eu-west-1" "dev"

echo ""
echo "--- 2. OIDC Providers + IAM Roles ---"
echo ""

echo "2a  shared-services"
ensure_oidc_provider "$SHARED_PROFILE" "$SHARED_ACCOUNT"
ensure_deploy_role   "$SHARED_PROFILE" "$SHARED_ACCOUNT"
ensure_ecr_role      "$SHARED_PROFILE" "$SHARED_ACCOUNT"

echo ""
echo "2b  dev"
ensure_oidc_provider "$DEV_PROFILE" "$DEV_ACCOUNT"
ensure_deploy_role   "$DEV_PROFILE" "$DEV_ACCOUNT"

echo ""
echo "2c  staging"
ensure_oidc_provider "$STAGING_PROFILE" "$STAGING_ACCOUNT"
ensure_deploy_role   "$STAGING_PROFILE" "$STAGING_ACCOUNT"

echo ""
echo "2d  prod"
ensure_oidc_provider "$PROD_PROFILE" "$PROD_ACCOUNT"
ensure_deploy_role   "$PROD_PROFILE" "$PROD_ACCOUNT"

echo ""
echo "=== Done. ==="
echo ""
echo "GitHub Actions variables (set at org level → Variables, not Secrets):"
echo "  AWS_REGION              = ${REGION}"
echo "  AWS_ECR_ROLE            = arn:aws:iam::${SHARED_ACCOUNT}:role/GitHubActionsECRRole"
echo "  AWS_DEPLOY_ROLE_SHARED  = arn:aws:iam::${SHARED_ACCOUNT}:role/GitHubActionsDeployRole"
echo "  AWS_DEPLOY_ROLE_DEV     = arn:aws:iam::${DEV_ACCOUNT}:role/GitHubActionsDeployRole"
echo "  AWS_DEPLOY_ROLE_STAGING = arn:aws:iam::${STAGING_ACCOUNT}:role/GitHubActionsDeployRole"
echo "  AWS_DEPLOY_ROLE_PROD    = arn:aws:iam::${PROD_ACCOUNT}:role/GitHubActionsDeployRole"
echo ""
echo "Next:"
echo "  gh workflow run deploy-shared-services.yml --repo heediq/heediq-infra --ref develop"
echo "  → capture CloudFormation outputs → fill lib/config.ts → update NS records at registrar"
echo ""
