#!/usr/bin/env bash
# Checks the deployed stack really works: calls the API, runs every route, sends a real message to
# every trigger and follows it on through the connected services.
#
#   bash scripts/smoke-test.sh
#
# Run it after scripts/deploy.sh. Needs the AWS CLI v2 and curl; takes 1-3 minutes and costs a
# fraction of a cent. It only creates data marked "smoke-test" / "SAMPLE#", and removes it at the end
# (a sample message can stay in a queue that no function reads until the queue's retention ends).
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "${BASH_SOURCE[0]}")/.."

STACK_NAME="${STACK_NAME:-serverless-fraud-detection-p}"
AWS_REGION="${AWS_REGION:-$(aws configure get region || true)}"
AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" >/dev/null 2>&1; then
  echo "Stack $STACK_NAME isn't deployed in $AWS_REGION. Run bash scripts/deploy.sh first (same STACK_NAME and AWS_REGION)." >&2
  exit 1
fi
RUN="smoke$(date +%s)"
START_MS="$(( ($(date +%s) - 60) * 1000 ))"
# A relative folder: on Windows the AWS CLI can't open Git Bash's /tmp paths.
TMP="build/smoke-test-$RUN"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
echo "Smoke test of $STACK_NAME in $AWS_REGION (run $RUN)"

passed=0; failed=0
pass() { printf '  \033[32mok\033[0m    %s\n' "$*"; passed=$((passed + 1)); }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; failed=$((failed + 1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$*"; }
physical() { aws cloudformation describe-stack-resource --stack-name "$STACK_NAME" --logical-resource-id "$1" --query StackResourceDetail.PhysicalResourceId --output text; }
output() { aws cloudformation describe-stacks --stack-name "$STACK_NAME" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }

# invoke <function logical id> <payload json>: runs the function; its reply is in $TMP/out.json.
invoke() {
  local err
  err="$(aws lambda invoke --function-name "$(physical "$1")" --cli-binary-format raw-in-base64-out --payload "$2" --query FunctionError --output text "$TMP/out.json" 2>"$TMP/err.txt")" || { cp "$TMP/err.txt" "$TMP/out.json"; return 1; }
  [ "$err" = "None" ]
}
# api <function logical id> <method> <path> [json body]: one API request, sent straight to the function.
api() {
  local body="${4:-}" esc
  esc="${body//\\/\\\\}"; esc="${esc//\"/\\\"}"
  invoke "$1" "{\"version\":\"2.0\",\"routeKey\":\"\$default\",\"rawPath\":\"$3\",\"rawQueryString\":\"\",\"headers\":{\"content-type\":\"application/json\"},\"requestContext\":{\"http\":{\"method\":\"$2\",\"path\":\"$3\"}},\"isBase64Encoded\":false${body:+,\"body\":\"$esc\"}}" || true
}
# expect <status> <description>: checks the status code of the last api reply.
expect() {
  local want="$1" got; shift
  got="$(grep -o '"statusCode": *[0-9]*' "$TMP/out.json" | head -1 | grep -o '[0-9]*$')"
  if [ "$got" = "$want" ]; then pass "$*"; else fail "$* (got ${got:-an error}: $(head -c 300 "$TMP/out.json"))"; fi
}
# field <name>: a text field from the JSON body of the last api reply.
field() { grep -o "\\\\\"$1\\\\\":\\\\\"[^\\\\]*" "$TMP/out.json" | head -1 | sed 's/.*\\"//'; }
# http <url> [curl args...]: prints the HTTP status code.
http() { local url="$1"; shift; curl -s -o /dev/null -w '%{http_code}' "$@" "$url" || true; }
# seen <function logical id> <text>: waits (2.5 minutes at most, shared by all waits) for the text in the function's logs.
DEADLINE=0
seen() {
  local group n
  group="/aws/lambda/$(physical "$1")"
  [ "$DEADLINE" -gt 0 ] || DEADLINE=$(( $(date +%s) + 150 ))
  while :; do
    n="$(aws logs filter-log-events --log-group-name "$group" --start-time "$START_MS" --filter-pattern "\"$2\"" --query 'length(events)' --output text 2>/dev/null)"
    if [ -n "$n" ] && [ "$n" != "0" ] && [ "$n" != "None" ]; then return 0; fi
    [ "$(date +%s)" -lt "$DEADLINE" ] || return 1
    sleep 5
  done
}

section "Over the internet (API Gateway)"
URL="$(output TransactionsApiUrl)"
code="$(http "$URL/ingest-function/health")"; if [ "$code" = 200 ]; then pass "GET /ingest-function/health on Transactions API answers 200"; else fail "GET /ingest-function/health on Transactions API answered $code (expected 200)"; fi
code="$(http "$URL/query-function/health")"; if [ "$code" = 200 ]; then pass "GET /query-function/health on Transactions API answers 200"; else fail "GET /query-function/health on Transactions API answered $code (expected 200)"; fi

section "Transaction Ingest: API routes (sent straight to the function)"
api IngestFunction GET "/ingest-function/health"; expect 200 "GET /ingest-function/health"
api IngestFunction POST "/ingest-function/processing-queue/messages" "{\"sample\":true,\"runId\":\"$RUN-ingest-function\",\"hops\":1}"; expect 202 "POST /ingest-function/processing-queue/messages sends to Processing Queue"

section "Query Flagged Transactions: API routes (sent straight to the function)"
api QueryFunction GET "/query-function/health"; expect 200 "GET /query-function/health"
api QueryFunction POST "/query-function/flagged-table" "{\"title\":\"smoke test $RUN\"}"; expect 201 "POST /query-function/flagged-table saves an item in Flagged Transactions Table"
ID="$(field id)"
api QueryFunction GET "/query-function/flagged-table/$ID"; expect 200 "GET /query-function/flagged-table/{id} reads it back"
api QueryFunction DELETE "/query-function/flagged-table/$ID"; expect 204 "DELETE /query-function/flagged-table/{id} removes it"

section "Event-driven functions: a real message to each trigger"
if aws sqs send-message --queue-url "$(physical ProcessingQueue)" --message-body "{\"sample\":true,\"runId\":\"$RUN-processing-queue\",\"hops\":0}" >/dev/null; then pass "sent a message to Processing Queue (SQS)"; else fail "couldn't send to Processing Queue"; fi
if invoke ExplainerFunction "{\"sample\":true,\"runId\":\"$RUN-explainer-function\",\"hops\":0}"; then pass "Bedrock Explainer runs when invoked directly"; else fail "Bedrock Explainer failed: $(head -c 300 "$TMP/out.json")"; fi

section "Following the messages (CloudWatch Logs)"
if seen ScoringFunction "$RUN-ingest-function"; then pass "Transaction Ingest -> Processing Queue -> Fraud Scoring Engine"; else fail "Transaction Ingest -> Processing Queue -> Fraud Scoring Engine: the message didn't arrive"; fi
if seen ScoringFunction "$RUN-processing-queue"; then pass "Fraud Scoring Engine received it"; else fail "Fraud Scoring Engine didn't receive it (see its CloudWatch logs)"; fi
if seen ExplainerFunction "$RUN-processing-queue"; then pass "Fraud Scoring Engine -> Bedrock Explainer -> Bedrock Explainer"; else fail "Fraud Scoring Engine -> Bedrock Explainer -> Bedrock Explainer: the message didn't arrive"; fi
if seen ExplainerFunction "$RUN-explainer-function"; then pass "Bedrock Explainer received it"; else fail "Bedrock Explainer didn't receive it (see its CloudWatch logs)"; fi

section "Cleaning up"
TABLE="$(physical FlaggedTable)"
aws dynamodb scan --table-name "$TABLE" --filter-expression "begins_with(pk, :p)" --expression-attribute-values "{\":p\":{\"S\":\"SAMPLE#$RUN\"}}" --query 'Items[].[pk.S, sk.S]' --output text 2>/dev/null | tr -d '\r' |
  while read -r pk sk; do [ -n "$pk" ] && [ "$pk" != None ] && { aws dynamodb delete-item --table-name "$TABLE" --key "{\"pk\":{\"S\":\"$pk\"},\"sk\":{\"S\":\"$sk\"}}" || echo failed >> "$TMP/cleanup"; }; done
if [ -s "$TMP/cleanup" ]; then fail "some smoke-test data couldn't be removed (items starting SAMPLE#$RUN)"; else pass "removed the smoke-test data"; fi

printf '\n%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" = 0 ] || exit 1
