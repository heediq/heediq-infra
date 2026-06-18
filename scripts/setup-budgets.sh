#!/usr/bin/env bash
# heediq-infra/scripts/setup-budgets.sh
#
# Creates $50/month cost budgets for the dev account (276594885933).
# Budgets live in the management account with a LinkedAccount filter — no CDK
# bootstrap required in the management account (D-036, D-056).
# Run once; idempotent (safe to re-run).
#
# PREREQUISITES
# ─────────────
# 1. Configure the management account SSO profile (one-time):
#
#      aws configure sso --profile heediq-management
#
#    Prompts:
#      SSO start URL  → from IAM Identity Center in the management account
#      SSO region     → eu-west-1
#      CLI profile    → heediq-management
#
# 2. Log in before running (SSO tokens expire):
#
#      aws sso login --profile heediq-management
#
# 3. python3 must be installed (pre-installed on macOS).
#
# RUN
# ───
#   chmod +x scripts/setup-budgets.sh
#   ./scripts/setup-budgets.sh
#
# BLOCK AT 100%
# ─────────────
# Not yet automated. Set up manually in the AWS Console after running this script:
#   Billing → Budgets → heediq-dev-actual → Manage → Add alert threshold
#   → Actions → Create action
#   Action type : Apply SCP policy (blocks resource creation org-wide for dev account)
#   Threshold   : 100% ACTUAL
#   Approval    : Automatic

set -euo pipefail

PROFILE="heediq-management"
DEV_ACCOUNT="276594885933"  # D-045
AMOUNT="50"                 # USD/month — D-056
EMAIL="andriiperevoznyi@gmail.com"

# ── Auth ──────────────────────────────────────────────────────────────────────

MGMT_ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE" \
    --query Account --output text 2>/dev/null) || {
  printf '\nAuth failed. Run:\n'
  printf '  aws sso login --profile %s\n\n' "$PROFILE"
  printf 'Profile not yet configured? Run:\n'
  printf '  aws configure sso --profile %s\n\n' "$PROFILE"
  exit 1
}

printf 'Management : %s\nDev account: %s\nBudget     : $%s/month  →  %s\n\n' \
  "$MGMT_ACCOUNT" "$DEV_ACCOUNT" "$AMOUNT" "$EMAIL"

# ── Helpers ───────────────────────────────────────────────────────────────────

make_notifications() {
  local ntype="$1"  # ACTUAL | FORECASTED
  python3 - <<EOF
import json
result = []
for t in [1, 10, 25, 50, 70, 85, 95]:
    result.append({
        "Notification": {
            "NotificationType": "$ntype",
            "ComparisonOperator": "GREATER_THAN",
            "Threshold": t,
            "ThresholdType": "PERCENTAGE"
        },
        "Subscribers": [{"SubscriptionType": "EMAIL", "Address": "$EMAIL"}]
    })
print(json.dumps(result))
EOF
}

budget_exists() {
  aws budgets describe-budget \
      --profile "$PROFILE" --account-id "$MGMT_ACCOUNT" \
      --budget-name "$1" &>/dev/null
}

create_budget() {
  local name="$1" ntype="$2"

  if budget_exists "$name"; then
    printf '  [%s] already exists — skipping.\n' "$name"
    return
  fi

  aws budgets create-budget \
    --profile "$PROFILE" \
    --account-id "$MGMT_ACCOUNT" \
    --budget "{
      \"BudgetName\": \"$name\",
      \"BudgetLimit\": {\"Amount\": \"$AMOUNT\", \"Unit\": \"USD\"},
      \"TimeUnit\": \"MONTHLY\",
      \"BudgetType\": \"COST\",
      \"CostFilters\": {\"LinkedAccount\": [\"$DEV_ACCOUNT\"]}
    }" \
    --notifications-with-subscribers "$(make_notifications "$ntype")"

  printf '  [%s] created.\n' "$name"
}

# ── Create ─────────────────────────────────────────────────────────────────────
# Split into two budgets — AWS allows max 10 notifications per budget;
# 7 thresholds × 2 types (ACTUAL + FORECASTED) = 14, so we split them.
# Note: FORECASTED alerts need ~1 month of usage history before AWS can generate
# forecasts — they will not fire in the first billing period.

printf 'Creating budgets...\n'
create_budget "heediq-dev-actual"     "ACTUAL"
create_budget "heediq-dev-forecasted" "FORECASTED"

printf '\nDone. Both budgets active in the management account.\n\n'
printf 'Verify in the console:\n'
printf '  https://console.aws.amazon.com/billing/home#/budgets\n'
printf '  (sign in to the management account via IAM Identity Center)\n\n'
printf 'Next: set up the 100%% block action manually — see header comment above.\n'
