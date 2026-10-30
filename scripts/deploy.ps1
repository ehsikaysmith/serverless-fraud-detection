# Builds the Lambda code and deploys the CloudFormation stack to your AWS account (Windows PowerShell).
#
#   .\scripts\deploy.ps1
#   .\scripts\deploy.ps1 -StackName my-app -Region eu-west-1
#
# Needs Node.js 20+, the AWS CLI v2 and AWS credentials (aws configure, or aws sso login).
param(
  [string]$StackName = $(if ($env:STACK_NAME) { $env:STACK_NAME } else { 'serverless-fraud-detection-p' }),
  [string]$Region = $env:AWS_REGION
)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Invoke-Checked {
  param([string]$File, [string[]]$Arguments)
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) { throw 'The AWS CLI v2 is required.' }
$AccountId = (& aws sts get-caller-identity --query Account --output text)
if ($LASTEXITCODE -ne 0) { throw "AWS credentials are not set up. Run 'aws configure' or 'aws sso login'." }
if (-not $Region) { $Region = (& aws configure get region) }
if (-not $Region) { $Region = 'us-east-1' }
$env:AWS_REGION = $Region
$env:AWS_DEFAULT_REGION = $Region
Write-Host "Deploying stack $StackName to account $AccountId in $Region"

Write-Host '==> Building the Lambda code'
Invoke-Checked npm @('install', '--no-audit', '--no-fund')
Invoke-Checked npm @('run', 'build')

$Bucket = "$StackName-artifacts-$AccountId-$Region".ToLower()
if ($Bucket.Length -gt 63) { $Bucket = $Bucket.Substring(0, 63) }
& aws s3api head-bucket --bucket $Bucket 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  Write-Host "==> Creating the deployment bucket $Bucket"
  if ($Region -eq 'us-east-1') {
    Invoke-Checked aws @('s3api', 'create-bucket', '--bucket', $Bucket)
  } else {
    Invoke-Checked aws @('s3api', 'create-bucket', '--bucket', $Bucket, '--create-bucket-configuration', "LocationConstraint=$Region")
  }
  Invoke-Checked aws @('s3api', 'put-public-access-block', '--bucket', $Bucket, '--public-access-block-configuration', 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true')
}

Write-Host '==> Uploading the code and deploying (the first deploy can take a few minutes)'
Invoke-Checked aws @('cloudformation', 'package', '--template-file', 'infrastructure/template.yaml', '--s3-bucket', $Bucket, '--s3-prefix', $StackName, '--output-template-file', 'build/packaged.yaml')
Invoke-Checked aws @('cloudformation', 'deploy', '--template-file', 'build/packaged.yaml', '--stack-name', $StackName, '--capabilities', 'CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM', '--no-fail-on-empty-changeset')

Write-Host '==> Done. Stack outputs:'
Invoke-Checked aws @('cloudformation', 'describe-stacks', '--stack-name', $StackName, '--query', 'Stacks[0].Outputs[].[OutputKey,OutputValue]', '--output', 'table')
Write-Host 'Next: bash scripts/smoke-test.sh (Git Bash) checks that everything works.'
