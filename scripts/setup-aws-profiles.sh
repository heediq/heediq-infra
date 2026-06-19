#!/usr/bin/env bash
set -euo pipefail

# =============================================================
# Heediq — AWS SSO Profile Setup
#
# INFRA OWNER / ADMIN ONLY
# Regular developers do not need this — local development uses
# DynamoDB Local / LocalStack, and CI handles all AWS deployments
# via OIDC (no stored credentials needed anywhere).
#
# Run this once on a new machine to configure AWS CLI SSO profiles
# for all four Heediq accounts. Requires the IAM Identity Center
# start URL from the management account console (ask Andrii).
#
# After running, log in before each AWS session:
#   aws sso login --profile heediq-shared
#   aws sso login --profile heediq-dev
#   etc.
# =============================================================

REGION="eu-west-1"

PROFILES=(
  "heediq-shared:313828097088:AdministratorAccess"
  "heediq-dev:276594885933:AdministratorAccess"
  "heediq-staging:475790160542:AdministratorAccess"
  "heediq-prod:438825592314:AdministratorAccess"
)

echo ""
echo "=== Heediq AWS SSO Profile Setup ==="
echo ""
echo "You need the IAM Identity Center start URL (from management account → IAM Identity Center)."
read -rp "SSO start URL: " SSO_START_URL

if [[ -z "$SSO_START_URL" ]]; then
  echo "No URL provided. Exiting."
  exit 1
fi

echo ""

for entry in "${PROFILES[@]}"; do
  IFS=':' read -r profile account_id permission_set <<< "$entry"

  echo "Configuring profile: $profile (account $account_id)"

  # aws configure sso is interactive — write config directly instead
  aws configure set "profile.${profile}.sso_start_url"    "$SSO_START_URL"
  aws configure set "profile.${profile}.sso_region"       "$REGION"
  aws configure set "profile.${profile}.sso_account_id"   "$account_id"
  aws configure set "profile.${profile}.sso_role_name"    "$permission_set"
  aws configure set "profile.${profile}.region"           "$REGION"
  aws configure set "profile.${profile}.output"           "json"

  echo "  [ok]   $profile"
done

echo ""
echo "=== Done ==="
echo ""
echo "Log in to start an AWS session:"
echo "  aws sso login --profile heediq-shared"
echo "  aws sso login --profile heediq-dev"
echo "  aws sso login --profile heediq-staging"
echo "  aws sso login --profile heediq-prod"
echo ""
echo "Or log in to all at once:"
echo "  for p in heediq-shared heediq-dev heediq-staging heediq-prod; do"
echo "    aws sso login --profile \$p"
echo "  done"
echo ""
