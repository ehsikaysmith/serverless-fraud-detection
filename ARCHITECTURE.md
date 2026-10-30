# Serverless Fraud Detection Platform

A serverless, event-driven fraud detection platform that scores card transactions in near real-time using rule-based checks and an Isolation Forest ML model on Lambda. Transactions flow through an HTTP API to an SQS-decoupled scoring pipeline. Flagged transactions are stored in DynamoDB with AI-generated explanations from Amazon Bedrock, and high-risk alerts go via SNS. All raw and scored data lands in S3 in Parquet format, queryable through Glue Data Catalog and Athena for fraud pattern analytics. CloudWatch provides dashboards and alarms across all components.

**Region:** us-east-1

Diagram: `architecture.drawio` (open it in draw.io or diagrams.net).

## Services

| Id | Name | Service | Purpose | Settings |
|---|---|---|---|---|
| `transactions-api` | Transactions API | Amazon API Gateway (HTTP API) | HTTP API with two routes: POST /transactions for ingestion and GET /flagged for querying flagged transactions with explanations | apiType: http, requestsPerMonth: 160000 |
| `ingest-function` | Transaction Ingest | AWS Lambda | Validates incoming transaction payload (card, amount, merchant, location, timestamp), assigns a transaction ID, and sends it to the processing queue | architecture: arm64, avgDurationMs: 200, memoryMb: 256, requestsPerMonth: 150000, timeoutSeconds: 10 |
| `processing-queue` | Processing Queue | Amazon SQS | Decouples ingestion from scoring, provides back-pressure and retry semantics with a 3-retry redrive policy to the DLQ | requestsPerMonth: 300000 |
| `dead-letter-queue` | Dead Letter Queue | Amazon SQS | Captures messages that fail scoring 3 times for manual investigation; triggers a CloudWatch alarm when non-empty | requestsPerMonth: 1000 |
| `scoring-function` | Fraud Scoring Engine | AWS Lambda | Runs rule-based checks (amount threshold, velocity per card in 1h window, geo-impossible travel) then scores with an Isolation Forest model packaged as a Lambda layer. Writes raw+scored data to S3, flagged transactions to DynamoDB, high-risk alerts to SNS, and async-invokes the explainer for flagged items | architecture: arm64, avgDurationMs: 3000, memoryMb: 1024, requestsPerMonth: 150000, timeoutSeconds: 30 |
| `transactions-bucket` | Transactions Data Lake | Amazon S3 | Stores all transaction data partitioned by date (year/month/day) in Parquet format for efficient Athena queries. Separate prefixes for raw/ and scored/ data. Encryption at rest with SSE-S3, versioning disabled to save cost, lifecycle policy to move to Glacier after 90 days | getsPerMonth: 50000, putsPerMonth: 300000, storageGb: 1 |
| `flagged-table` | Flagged Transactions Table | Amazon DynamoDB | Stores flagged transactions with attributes: transactionId (PK), timestamp (SK), riskScore, rulesFired, mlScore, explanation, merchantId, region. GSI on riskScore for high-risk queries. On-demand billing, encryption at rest, point-in-time recovery enabled | readsPerMonth: 20000, storageGb: 0.5, writesPerMonth: 15000 |
| `alerts-topic` | Fraud Alerts Topic | Amazon SNS | Publishes high-risk transaction alerts (riskScore > 0.85) to email subscribers. Message includes transaction ID, amount, merchant, risk score, and rules fired | publishesPerMonth: 1500 |
| `explainer-function` | Bedrock Explainer | AWS Lambda | Invoked asynchronously for flagged transactions. Calls Bedrock Claude 3 Haiku with the transaction context and scoring details to generate a plain-English fraud explanation. Enforces a monthly call cap via a DynamoDB counter. Updates the flagged table with the explanation | architecture: arm64, avgDurationMs: 2000, memoryMb: 256, requestsPerMonth: 1000, timeoutSeconds: 30 |
| `query-function` | Query Flagged Transactions | AWS Lambda | Handles GET /flagged endpoint with optional query parameters (minRiskScore, startDate, endDate, merchantId). Returns paginated flagged transactions with their Bedrock explanations from DynamoDB | architecture: arm64, avgDurationMs: 200, memoryMb: 256, requestsPerMonth: 10000, timeoutSeconds: 10 |
| `bedrock-ai` | Amazon Bedrock (Claude 3 Haiku) | External: Amazon Bedrock | Foundation model for generating plain-English fraud explanations. Capped at 1,000 calls/month (~$0.38/month). Prompt includes transaction details, risk score, rules fired, and ML anomaly score | provider: Amazon Bedrock |
| `glue-catalog` | AWS Glue Data Catalog | External: AWS Glue | Defines database and table schema over the S3 data lake, enabling Athena to query Parquet data without ETL. Table defined in CloudFormation (no crawler cost) | provider: AWS Glue |
| `athena-queries` | Amazon Athena | External: Amazon Athena | Ad-hoc SQL analytics on fraud patterns: fraud rate by hour, top flagged merchants, geographic hot spots, risk score distributions. Uses Parquet columnar format to minimize data scanned (~$0.001/month) | provider: Amazon Athena |
| `monitoring` | Monitoring Dashboard & Alarms | Amazon CloudWatch | Dashboard showing fraud rate, scoring latency, error rates, DLQ depth, API latency, and Bedrock call count. 6 alarms: scoring-errors, api-5xx, dlq-not-empty, scoring-p99-latency, lambda-throttles, monthly-cost-anomaly. 4 custom metrics: fraud-rate, avg-risk-score, flagged-count, explanation-latency | alarms: 6, customMetrics: 4, logsGbPerMonth: 1 |

## How they connect

- **Transactions API** → **Transaction Ingest**: POST /transactions → Lambda proxy integration
- **Transactions API** → **Query Flagged Transactions**: GET /flagged → Lambda proxy integration
- **Transaction Ingest** → **Processing Queue**: SendMessage with validated transaction payload
- **Processing Queue** → **Fraud Scoring Engine**: SQS event source mapping triggers scoring (batch size 10)
- **Processing Queue** → **Dead Letter Queue**: Redrive policy: maxReceiveCount=3
- **Fraud Scoring Engine** → **Transactions Data Lake**: PutObject to raw/ and scored/ prefixes in Parquet
- **Fraud Scoring Engine** → **Flagged Transactions Table**: PutItem for flagged transactions (riskScore > 0.5)
- **Fraud Scoring Engine** → **Fraud Alerts Topic**: Publish alert for high-risk transactions (riskScore > 0.85)
- **Fraud Scoring Engine** → **Bedrock Explainer**: Async Lambda invoke for flagged transactions needing explanation
- **Bedrock Explainer** → **Amazon Bedrock (Claude 3 Haiku)**: InvokeModel call to Claude 3 Haiku with transaction context
- **Bedrock Explainer** → **Flagged Transactions Table**: UpdateItem to add explanation text to flagged record
- **Query Flagged Transactions** → **Flagged Transactions Table**: Query by PK/SK or GSI for filtered, paginated results
- **Amazon Athena** → **Transactions Data Lake**: Scans Parquet partitions via Glue catalog
- **AWS Glue Data Catalog** → **Transactions Data Lake**: Schema overlay on S3 data lake partitions

## Assumptions

- Mid-range volume: ~5,000 transactions/day (~150,000/month)
- ~5% of transactions flagged (7,500/month), ~1% high-risk triggering SNS (1,500/month)
- Bedrock explanation calls capped at 1,000/month using Claude 3 Haiku (~$0.38/month billed separately)
- Isolation Forest model packaged as a Lambda layer (~50MB scikit-learn), needs 1024MB memory, ~3s inference
- S3 stores ~1GB/month in Parquet format; Athena scans ~100MB/month (~$0.001)
- Glue Data Catalog table defined in CloudFormation (no crawler), within free tier
- DynamoDB on-demand billing — ideal for variable portfolio workload, with point-in-time recovery
- All Lambda functions use arm64 (Graviton2) for ~20% cost savings vs x86
- SQS: ~300K API calls/month (send + receive + delete operations)
- 10,000 GET queries/month for the flagged transactions endpoint
- 6 CloudWatch alarms: scoring-errors, api-5xx, dlq-depth, scoring-p99, throttles, cost-anomaly
- 4 custom metrics published via CloudWatch embedded metric format from Lambda
- With AWS Free Tier (first 12 months): Lambda 1M requests + 400K GB-s free, HTTP API 1M requests free, SQS 1M requests free, DynamoDB 25GB free — actual cost likely under $5/month
- Bedrock, Glue Data Catalog, and Athena costs not included in estimate; add ~$0.40/month total

## Estimated monthly cost

**Total: $10.44/month**

| Service | Usage basis | Monthly |
|---|---|---:|
| Transactions API (Amazon API Gateway (HTTP API)) | 160,000 HTTP API requests | $0.16 |
| Transaction Ingest (AWS Lambda) | 150,000 requests × 200 ms at 256 MB (arm64) | $0.13 |
| Processing Queue (Amazon SQS) | 300,000 requests | $0.12 |
| Dead Letter Queue (Amazon SQS) | 1,000 requests | $0.00 |
| Fraud Scoring Engine (AWS Lambda) | 150,000 requests × 3000 ms at 1024 MB (arm64) | $6.03 |
| Transactions Data Lake (Amazon S3) | 1 GB Standard, 300,000 PUTs, 50,000 GETs | $1.54 |
| Flagged Transactions Table (Amazon DynamoDB) | On-demand: 20,000 reads, 15,000 writes, 0.5 GB | $0.14 |
| Fraud Alerts Topic (Amazon SNS) | 1,500 publishes | $0.00 |
| Bedrock Explainer (AWS Lambda) | 1,000 requests × 2000 ms at 256 MB (arm64) | $0.01 |
| Query Flagged Transactions (AWS Lambda) | 10,000 requests × 200 ms at 256 MB (arm64) | $0.01 |
| Amazon Bedrock (Claude 3 Haiku) (External service) | Not an AWS service; billed separately by Amazon Bedrock | $0.00 |
| AWS Glue Data Catalog (External service) | Not an AWS service; billed separately by AWS Glue | $0.00 |
| Amazon Athena (External service) | Not an AWS service; billed separately by Amazon Athena | $0.00 |
| Monitoring Dashboard & Alarms (Amazon CloudWatch) | 1 GB logs, 6 alarms, 4 custom metrics | $2.30 |

_Estimate based on AWS on-demand list prices (us-east-1) and the usage assumptions shown. Free tiers are not subtracted, and data transfer between services is not included. Check the AWS Pricing Calculator before committing._

## Not generated automatically

- Connection processing-queue → dead-letter-queue (sqs->sqs) is shown in the design but not wired automatically.
- Bedrock Explainer calls Amazon Bedrock (Claude 3 Haiku) (external): store its API key or credentials in AWS Secrets Manager, read them at runtime, and call the provider's API over HTTPS.
- Amazon Athena (external) sends data to Transactions Data Lake: connect them using the provider's integration for AWS (for example a webhook through API Gateway or an EventBridge partner event source).
- AWS Glue Data Catalog (external) sends data to Transactions Data Lake: connect them using the provider's integration for AWS (for example a webhook through API Gateway or an EventBridge partner event source).
- Some resources are named after the stack, so keep the stack name under 30 characters.
