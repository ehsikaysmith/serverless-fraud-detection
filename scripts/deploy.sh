#!/usr/bin/env bash
# Builds the Lambda code and deploys the CloudFormation stack to your AWS account.
#
#   bash scripts/deploy.sh
#   STACK_NAME=my-app AWS_REGION=eu-west-1 bash scripts/deploy.sh
#
# Needs Node.js 20+, the AWS CLI v2 and AWS credentials (aws configure, or aws sso login).
# Works in Git Bash on Windows, macOS and Linux.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "${BASH_SOURCE[0]}")/.."

STACK_NAME="${STACK_NAME:-serverless-fraud-detection-p}"
command -v aws >/dev/null || { echo "The AWS CLI v2 is required: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html" >&2; exit 1; }
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" || { echo "AWS credentials are not set up. Run 'aws configure' or 'aws sso login'." >&2; exit 1; }
AWS_REGION="${AWS_REGION:-$(aws configure get region || true)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
echo "Deploying stack $STACK_NAME to account $ACCOUNT_ID in $AWS_REGION"

echo "==> Building the Lambda code"
npm install --no-audit --no-fund
npm run build

BUCKET="$(printf '%s' "${STACK_NAME}-artifacts-${ACCOUNT_ID}-${AWS_REGION}" | tr '[:upper:]' '[:lower:]' | cut -c1-63)"
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  echo "==> Creating the deployment bucket $BUCKET"
  if [ "$AWS_REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  else
    aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
fi

echo "==> Uploading the code and deploying (the first deploy can take a few minutes)"
aws cloudformation package \
  --template-file infrastructure/template.yaml \
  --s3-bucket "$BUCKET" --s3-prefix "$STACK_NAME" \
  --output-template-file build/packaged.yaml >/dev/null
aws cloudformation deploy \
  --template-file build/packaged.yaml \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset

echo "==> Done. Stack outputs:"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
echo "Next: bash scripts/smoke-test.sh checks that everything works."
