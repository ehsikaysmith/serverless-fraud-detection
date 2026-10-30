#!/usr/bin/env bash
# Deletes the stack and everything it created.
#   bash scripts/destroy.sh
# Buckets the stack created that still contain files can't be deleted: empty them first in the S3 console.
set -euo pipefail
export MSYS_NO_PATHCONV=1
STACK_NAME="${STACK_NAME:-serverless-fraud-detection-p}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || true)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
read -r -p "Delete stack $STACK_NAME in $AWS_REGION and all its resources (data included)? Type the stack name to confirm: " answer
[ "$answer" = "$STACK_NAME" ] || { echo "Cancelled."; exit 1; }
aws cloudformation delete-stack --stack-name "$STACK_NAME"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME"
echo "Deleted $STACK_NAME."

# The deployment bucket only holds the uploaded build files (scripts/deploy.sh creates it).
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="$(printf '%s' "${STACK_NAME}-artifacts-${ACCOUNT_ID}-${AWS_REGION}" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"
if aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 rb "s3://$BUCKET" --force >/dev/null && echo "Deleted the deployment bucket $BUCKET."
fi
