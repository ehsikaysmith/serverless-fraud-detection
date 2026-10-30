# Extending Serverless Fraud Detection Platform

This project is a tested starting point, not a finished application. AWS Architecture Advisor designed
the architecture and generated sample code that proves each part works; building the actual features
is up to you, with whatever editor, framework or coding tool you like. This guide shows where things go
and how each choice affects cost.

## How the project fits together

- `infrastructure/template.yaml` (CloudFormation) defines every AWS resource. Change the infrastructure
  there, then run `bash scripts/deploy.sh` again.
- Each function's code is in `functions/ingest-function/index.ts`, `functions/scoring-function/index.ts`, `functions/explainer-function/index.ts`, `functions/query-function/index.ts` (TypeScript (Node.js 22)).
  The helpers at the top of each file call the connected services, reading the names the template sets
  as environment variables.
- After every change: `bash scripts/check.sh` (lint, type-check, tests, build, vulnerability audit),
  then deploy, then `bash scripts/smoke-test.sh` to see everything still works in AWS.

## Amazon API Gateway (HTTP API) (Transactions API)

- It is an HTTP API (cheaper and faster than a REST API). Every request goes to the function that serves its path.
- Throttle it before going live: add `DefaultRouteSettings: { ThrottlingBurstLimit: 50, ThrottlingRateLimit: 20 }` to the `Stage`.
- CORS currently allows any origin (`*`). Set `AllowOrigins` to your site's address before production.
- Custom domain: add `AWS::ApiGatewayV2::DomainName` and `ApiMapping` with an ACM certificate.

**Cost:**
- Billed per million requests; there is no charge when idle.
- Responses that change rarely can be cached by putting CloudFront in front.

**Next tasks:**
- Validate request bodies against a schema and return 400 with a clear message for invalid input.
- Add pagination (a `nextToken`) to list routes.

## AWS Lambda (Transaction Ingest, Fraud Scoring Engine, Bedrock Explainer, Query Flagged Transactions)

- New route on an existing function: add an entry to its `routes` list; no template change needed.
- New function: copy a folder in `functions/`, then copy its `AWS::Lambda::Function`, `Role` and `Logs` resources in the template and give them new logical IDs.
- Give a function access to another resource by adding one IAM statement to its `Role` (only the actions it needs) and the resource name as an environment variable, the way the existing ones are wired.

**Cost:**
- You pay per request and per GB-second. Functions run on Arm (arm64), which costs about 20% less than x86.
- Memory sets CPU too: measure with AWS Lambda Power Tuning before raising it.
- Keep timeouts short; a stuck call that runs to a 15-minute timeout is billed for all of it.

**Next tasks:**
- Move the business logic of each route into its own module and keep the handler as a thin router.
- Add structured logging with a request id on every log line.

## Amazon SQS (Processing Queue, Dead Letter Queue)

- Each queue has a dead-letter queue: messages that fail 5 times go there instead of being lost. Add a CloudWatch alarm on its `ApproximateNumberOfMessagesVisible`.
- The visibility timeout is 6x the consuming function's timeout, as AWS recommends; keep that ratio if you change the timeout.
- Need strict ordering or exactly-once processing? Use a FIFO queue (`FifoQueue: true`, name ending in `.fifo`).

**Cost:**
- Billed per million requests; batching (up to 10 messages per call) cuts both cost and Lambda invocations.

**Next tasks:**
- Make the consumer idempotent: record processed message ids so a repeat delivery does nothing.
- Add an alarm when the dead-letter queue has messages.

## Amazon S3 (Transactions Data Lake)

- Browser uploads go straight to S3 with the upload link route, so large files never pass through Lambda.
- For uploads from a web page, add a `CorsConfiguration` to the bucket allowing `PUT` from your site.
- Old files: add a `LifecycleConfiguration` rule, e.g. move to `INTELLIGENT_TIERING` after 30 days or expire after 365.
- The bucket is private and encrypted. Serve files to users through CloudFront or short-lived download links, never by making it public.

**Cost:**
- Billed per GB stored and per request. Lifecycle rules are the main saving for data that gets old.
- Data served through CloudFront costs less to transfer than straight from S3.

**Next tasks:**
- Add a download link route that checks the signed-in user owns the file.
- Limit uploads to certain file types and a maximum size.

## Amazon DynamoDB (Flagged Transactions Table)

- Tables use a generic key: `pk` (partition) and `sk` (sort). Design keys around how you read, e.g. `pk = USER#<id>`, `sk = ORDER#<date>` to list a user's orders in date order with one Query.
- Another way to look items up: add a global secondary index (GSI), e.g. `GlobalSecondaryIndexes: [{ IndexName: gsi1, KeySchema: [{ AttributeName: gsi1pk, KeyType: HASH }, { AttributeName: gsi1sk, KeyType: RANGE }], Projection: { ProjectionType: ALL } }]` plus the two `AttributeDefinitions`.
- Expire old items for free: `TimeToLiveSpecification: { AttributeName: expiresAt, Enabled: true }` and store a Unix timestamp in `expiresAt`.
- Point-in-time recovery and encryption are already on.

**Cost:**
- On-demand billing: you pay per read and write, nothing when idle. Switch to provisioned capacity only once traffic is steady and predictable.
- Avoid `Scan` in request paths: it reads (and bills) the whole table. Use `Query` on a key or index.

**Next tasks:**
- Add a route that lists items for one user with a Query on pk, newest first.
- Use a conditional write so two requests can't create the same item twice.

## Amazon SNS (Fraud Alerts Topic)

- Add subscribers in the template: `AWS::SNS::Subscription` with `Protocol: email`, `sqs` or `lambda`.
- Send only some messages to a subscriber with a `FilterPolicy`.

**Cost:**
- Billed per million publishes plus deliveries; email and SMS deliveries cost more than queue or Lambda deliveries.

**Next tasks:**
- Add an email subscription for operations alerts.
## Also in the design

- Amazon CloudWatch: see ARCHITECTURE.md and the notes in README.md for what to set up.

## Before you go to production

Checked against the AWS Well-Architected Framework:

- **Security:** restrict CORS to your site; keep IAM statements to the exact actions and resources; never put secrets in code or environment variables (use Secrets Manager); turn on MFA for users.
- **Reliability:** alarms on function errors, dead-letter queues and API 5xx responses; retries with backoff; idempotent message handlers.
- **Operations:** one stack per environment (`STACK_NAME=myapp-dev`, `STACK_NAME=myapp-prod`); deploy from CI rather than a laptop; keep log retention short (14 days here).
- **Cost:** set an AWS Budget with an email alert; check Cost Explorer after the first week of real traffic; delete stacks you no longer use (`bash scripts/destroy.sh`).
- **Performance:** measure before tuning; right-size function memory; cache what you can.
- **Sustainability:** Arm functions and on-demand, pay-per-use services already avoid idle capacity.

## Changing the design

If what you're building needs a different architecture (another database, containers instead of
functions, a new integration), ask AWS Architecture Advisor in the same chat: it compares the options
on cost and the Well-Architected pillars and gives you a new starter kit. When you have code, use
**Upload code for review** to check it against the design.
