/**
 * Bedrock Explainer: Invoked asynchronously for flagged transactions. Calls Bedrock Claude 3 Haiku with the transaction context and scoring details to generate a plain-English fraud explanation. Enforces a monthly call cap via a DynamoDB counter. Updates the flagged table with the explanation
 * Triggered by: nothing in the design yet.
 * Environment (set by the template):
 *   FLAGGED_TABLE_TABLE_NAME: Flagged Transactions Table (dynamodb)
 *
 * Sample code: each part does one small, real thing with a connected service, so you can see the
 * architecture working (scripts/smoke-test.sh exercises it). Replace the samples with your own logic.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

// Clients are created once per container and reused across invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

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
    putFlaggedTransactionsTable({ ...next, pk: `SAMPLE#${next.runId}`, sk: `HOP#${next.hops}`, receivedAt: new Date().toISOString() }),
  ]);
}

export const handler = async (event: unknown): Promise<{ ok: boolean }> => {
  // Nothing in the design triggers this function yet: invoke it directly or connect a trigger.
  await handleSample(event);
  return { ok: true };
};
