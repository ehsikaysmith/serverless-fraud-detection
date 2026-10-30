/**
 * Fraud Scoring Engine: Runs rule-based checks (amount threshold, velocity per card in 1h window, geo-impossible travel) then scores with an Isolation Forest model packaged as a Lambda layer. Writes raw+scored data to S3, flagged transactions to DynamoDB, high-risk alerts to SNS, and async-invokes the explainer for flagged items
 * Triggered by: Processing Queue (sqs).
 * Environment (set by the template):
 *   ALERTS_TOPIC_TOPIC_ARN: Fraud Alerts Topic (sns)
 *   EXPLAINER_FUNCTION_FUNCTION_NAME: Bedrock Explainer (lambda)
 *   FLAGGED_TABLE_TABLE_NAME: Flagged Transactions Table (dynamodb)
 *   TRANSACTIONS_BUCKET_BUCKET_NAME: Transactions Data Lake (s3)
 *
 * Sample code: each part does one small, real thing with a connected service, so you can see the
 * architecture working (scripts/smoke-test.sh exercises it). Replace the samples with your own logic.
 */
import type { SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Clients are created once per container and reused across invocations.
const sns = new SNSClient({});
const lambda = new LambdaClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

/** Publish to Fraud Alerts Topic (SNS). */
export async function publishFraudAlertsTopic(message: unknown, subject?: string): Promise<string | undefined> {
  return (await sns.send(new PublishCommand({ TopicArn: process.env.ALERTS_TOPIC_TOPIC_ARN!, Message: JSON.stringify(message), Subject: subject }))).MessageId;
}

/** Send a readable plain-text alert to Fraud Alerts Topic (SNS), e.g. as an email. */
export async function sendFraudAlert(subject: string, text: string): Promise<void> {
  await sns.send(new PublishCommand({ TopicArn: process.env.ALERTS_TOPIC_TOPIC_ARN!, Subject: subject, Message: text }));
}

/** Run Bedrock Explainer (Lambda) in the background. */
export async function invokeBedrockExplainer(payload: unknown): Promise<void> {
  await lambda.send(new InvokeCommand({ FunctionName: process.env.EXPLAINER_FUNCTION_FUNCTION_NAME!, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
}

/** Flagged Transactions Table (DynamoDB). Items are keyed by pk (partition key) and sk (sort key). */
export async function putFlaggedTransactionsTable(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: process.env.FLAGGED_TABLE_TABLE_NAME!, Item: item }));
}
export async function getFlaggedTransactionsTable(pk: string, sk: string): Promise<Record<string, unknown> | undefined> {
  return (await ddb.send(new GetCommand({ TableName: process.env.FLAGGED_TABLE_TABLE_NAME!, Key: { pk, sk } }))).Item;
}
export async function deleteFlaggedTransactionsTable(pk: string, sk: string): Promise<void> {
  await ddb.send(new DeleteCommand({ TableName: process.env.FLAGGED_TABLE_TABLE_NAME!, Key: { pk, sk } }));
}

/** Transactions Data Lake (S3). */
export async function putTransactionsDataLakeObject(key: string, body: string | Uint8Array, contentType?: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: process.env.TRANSACTIONS_BUCKET_BUCKET_NAME!, Key: key, Body: body, ContentType: contentType }));
}
export async function getTransactionsDataLakeObject(key: string): Promise<string | undefined> {
  return (await s3.send(new GetObjectCommand({ Bucket: process.env.TRANSACTIONS_BUCKET_BUCKET_NAME!, Key: key }))).Body?.transformToString();
}
export async function listTransactionsDataLakeObjects(prefix = ''): Promise<{ key: string; size: number }[]> {
  const res = await s3.send(new ListObjectsV2Command({ Bucket: process.env.TRANSACTIONS_BUCKET_BUCKET_NAME!, Prefix: prefix, MaxKeys: 50 }));
  return (res.Contents ?? []).map((o) => ({ key: o.Key ?? '', size: o.Size ?? 0 }));
}
/** A link a browser can upload one file to directly, valid for 5 minutes (the file never passes through Lambda). */
export async function uploadTransactionsDataLakeUrl(key: string, contentType = 'application/octet-stream'): Promise<string> {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: process.env.TRANSACTIONS_BUCKET_BUCKET_NAME!, Key: key, ContentType: contentType }), { expiresIn: 300 });
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------- smoke-test samples
// scripts/smoke-test.sh sends messages marked { sample: true, runId, hops }. This function logs them and
// passes them on to the services it's connected to, up to 3 hops. Real traffic is never passed on.
const MAX_HOPS = 3;
interface Sample {
  sample: true;
  runId: string;
  hops: number;
}
function sampleOf(value: unknown): Sample | undefined {
  const v = asObject(value);
  if (v.sample === true && typeof v.runId === 'string') return { sample: true, runId: v.runId, hops: typeof v.hops === 'number' ? v.hops : MAX_HOPS };
  return v.detail !== undefined ? sampleOf(v.detail) : undefined; // EventBridge envelopes
}
async function handleSample(value: unknown): Promise<void> {
  const sample = sampleOf(value);
  if (!sample) return;
  console.log(JSON.stringify({ msg: 'Sample received', runId: sample.runId, hops: sample.hops }));
  if (sample.hops >= MAX_HOPS) return;
  const next: Sample = { ...sample, hops: sample.hops + 1 };
  await Promise.all([
    publishFraudAlertsTopic(next, 'Sample run'),
    invokeBedrockExplainer(next),
    putFlaggedTransactionsTable({ ...next, pk: `SAMPLE#${next.runId}`, sk: `HOP#${next.hops}`, receivedAt: new Date().toISOString() }),
  ]);
}

// ---------------------------------------------------------------- fraud scoring
/** Amounts at or above this are suspicious. Use the same currency your transactions use, and change it to suit. */
const AMOUNT_THRESHOLD = 5000;
/** A transaction with a riskScore at or above this is flagged and saved. */
const FLAG_AT = 0.5;
/** A transaction with a riskScore at or above this also sends an email alert (high-risk). */
const ALERT_AT = 0.8;

interface Transaction {
  transactionId: string;
  cardId: string;
  amount: number;
  merchantId: string;
  location: string;
  timestamp: string;
}
interface ScoredTransaction extends Transaction {
  riskScore: number;
  rulesFired: string[];
  flagged: boolean;
}

/** Returns the message as a transaction if it has every field, otherwise undefined. */
function asTransaction(value: unknown): Transaction | undefined {
  const { transactionId, cardId, amount, merchantId, location, timestamp } = asObject(value);
  if (
    typeof transactionId === 'string' && transactionId !== '' &&
    typeof cardId === 'string' && cardId !== '' &&
    typeof amount === 'number' && Number.isFinite(amount) && amount > 0 &&
    typeof merchantId === 'string' && merchantId !== '' &&
    typeof location === 'string' && location !== '' &&
    typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp))
  ) {
    return { transactionId, cardId, amount, merchantId, location, timestamp };
  }
  return undefined;
}

/** Rule-based score from 0 (normal) to 1 (very suspicious). More rules (velocity, travel, ML model) get added here. */
export function scoreTransaction(tx: Transaction): ScoredTransaction {
  const rulesFired: string[] = [];
  let riskScore = 0;
  if (tx.amount >= AMOUNT_THRESHOLD * 5) {
    rulesFired.push('VERY_HIGH_AMOUNT');
    riskScore = Math.max(riskScore, 0.9);
  } else if (tx.amount >= AMOUNT_THRESHOLD) {
    rulesFired.push('HIGH_AMOUNT');
    riskScore = Math.max(riskScore, 0.6);
  }
  return { ...tx, riskScore, rulesFired, flagged: riskScore >= FLAG_AT };
}

async function handleTransaction(tx: Transaction): Promise<void> {
  const scored = scoreTransaction(tx);
  console.log(JSON.stringify({ msg: 'Scored transaction', transactionId: scored.transactionId, riskScore: scored.riskScore, rulesFired: scored.rulesFired, flagged: scored.flagged }));
  if (!scored.flagged) return;
  // Same key every time for the same transaction, so a message that arrives twice just overwrites itself.
  await putFlaggedTransactionsTable({ ...scored, pk: scored.transactionId, sk: scored.timestamp, scoredAt: new Date().toISOString() });
  if (scored.riskScore >= ALERT_AT) {
    await sendFraudAlert(
      'Fraud alert: high-risk transaction',
      [
        'A high-risk transaction was detected.',
        '',
        `Transaction ID: ${scored.transactionId}`,
        `Card: ${scored.cardId}`,
        `Amount: ${scored.amount}`,
        `Merchant: ${scored.merchantId}`,
        `Location: ${scored.location}`,
        `Time: ${scored.timestamp}`,
        `Risk score: ${scored.riskScore}`,
        `Rules fired: ${scored.rulesFired.join(', ')}`,
      ].join('\n'),
    );
  }
}

export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  if (sampleOf(event)) {
    await handleSample(event); // invoked directly by another function
    return { batchItemFailures: [] };
  }
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      const message = parseJson(record.body);
      if (sampleOf(message)) {
        await handleSample(message); // smoke-test message from the starter kit
      } else {
        const transaction = asTransaction(message);
        if (!transaction) throw new Error('Message is not a valid transaction'); // retried, then moved to the dead-letter queue
        await handleTransaction(transaction);
      }
      console.log(JSON.stringify({ msg: 'Processed message', messageId: record.messageId }));
    } catch (err) {
      console.error(JSON.stringify({ msg: 'Failed to process message', messageId: record.messageId, error: String(err) }));
      batchItemFailures.push({ itemIdentifier: record.messageId }); // only this message is retried
    }
  }
  return { batchItemFailures };
};
