/**
 * Transaction Ingest: Validates incoming transaction payload (card, amount, merchant, location, timestamp), assigns a transaction ID, and sends it to the processing queue
 * Triggered by: HTTP API (Transactions API).
 * Environment (set by the template):
 *   PROCESSING_QUEUE_QUEUE_URL: Processing Queue (sqs)
 *
 * Sample code: each part does one small, real thing with a connected service, so you can see the
 * architecture working (scripts/smoke-test.sh exercises it). Replace the samples with your own logic.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';

// Clients are created once per container and reused across invocations.
const sqs = new SQSClient({});

/** Send a message to Processing Queue (SQS). */
export async function sendProcessingQueue(message: unknown): Promise<string | undefined> {
  return (await sqs.send(new SendMessageCommand({ QueueUrl: process.env.PROCESSING_QUEUE_QUEUE_URL!, MessageBody: JSON.stringify(message) }))).MessageId;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// ---------------------------------------------------------------- transactions
/** The shape every transaction has once it has been checked and given an ID. */
export interface Transaction {
  transactionId: string;
  cardId: string;
  amount: number;
  merchantId: string;
  location: string;
  /** ISO 8601 date and time, e.g. 2026-10-28T12:00:00.000Z */
  timestamp: string;
}

/** Check an incoming payload. Returns the transaction (with a new ID) or a list of what is wrong. */
export function validateTransaction(input: unknown): { errors: string[]; transaction?: Transaction } {
  const v = asObject(input);
  const errors: string[] = [];
  const text = (field: string): string | undefined => {
    const value = v[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    errors.push(`${field} is required and must be text`);
    return undefined;
  };
  const cardId = text('cardId');
  const merchantId = text('merchantId');
  const location = text('location');
  const timestamp = text('timestamp');
  const amount = v.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) errors.push('amount must be a number greater than 0');
  if (timestamp !== undefined && Number.isNaN(Date.parse(timestamp))) errors.push('timestamp must be a valid date, for example 2026-10-28T12:00:00Z');
  if (errors.length > 0 || cardId === undefined || merchantId === undefined || location === undefined || timestamp === undefined || typeof amount !== 'number') {
    return { errors };
  }
  return { errors, transaction: { transactionId: randomUUID(), cardId, amount, merchantId, location, timestamp: new Date(timestamp).toISOString() } };
}

// ---------------------------------------------------------------- HTTP API
/** Path prefix this function serves (the API is shared, so its routes are under /ingest-function). */
const PREFIX = '/ingest-function';
const json = (statusCode: number, body?: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? '' : JSON.stringify(body),
});

interface Req {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
  /** Cognito token claims (protected APIs only). */
  claims?: Record<string, unknown>;
}
type Route = [method: string, path: string, run: (req: Req) => Promise<APIGatewayProxyResultV2>];

// These routes are public: add an authorizer in the template before storing real data.
const routes: Route[] = [
  ['GET', '/health', async () => {
    return json(200, { ok: true, function: 'ingest-function' });
  }],
  // Real route: checks the transaction, gives it an ID, and puts it on the processing queue for scoring.
  ['POST', '/transactions', async (req) => {
    const { errors, transaction } = validateTransaction(req.body);
    if (!transaction) return json(400, { message: 'Invalid transaction.', errors });
    const messageId = await sendProcessingQueue(transaction);
    return json(202, { transactionId: transaction.transactionId, messageId });
  }],
  // Sample route from the starter kit (scripts/smoke-test.sh uses it). It sends ANY JSON to the queue with no
  // checking, so remove it once you no longer need the smoke test.
  ['POST', '/processing-queue/messages', async (req) => {
    return json(202, { messageId: await sendProcessingQueue(asObject(req.body)) });
  }],
];

function match(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith('{')) params[want[i]!.slice(1, -1)] = decodeURIComponent(got[i]!);
    else if (want[i] !== got[i]) return undefined;
  }
  return params;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const method = event.requestContext.http.method;
  const path = (event.rawPath.startsWith(PREFIX) ? event.rawPath.slice(PREFIX.length) : event.rawPath) || '/';
  let body: unknown;
  try {
    body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : undefined;
  } catch {
    return json(400, { message: 'The request body must be JSON.' });
  }
  const claims = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, unknown> } } }).authorizer?.jwt?.claims;
  for (const [m, pattern, run] of routes) {
    const params = m === method ? match(pattern, path) : undefined;
    if (!params) continue;
    try {
      return await run({ params, query: event.queryStringParameters ?? {}, body, claims });
    } catch (err) {
      console.error(JSON.stringify({ msg: 'Request failed', method, path, error: String(err) }));
      return json(500, { message: 'Something went wrong.' });
    }
  }
  return json(404, { message: `No route for ${method} ${path}`, routes: routes.map(([m, p]) => `${m} ${PREFIX}${p}`) });
};
