/**
 * Query Flagged Transactions: Handles GET /flagged endpoint with optional query parameters (minRiskScore, startDate, endDate, merchantId). Returns paginated flagged transactions with their Bedrock explanations from DynamoDB
 * Triggered by: HTTP API (Transactions API).
 * Environment (set by the template):
 *   FLAGGED_TABLE_TABLE_NAME: Flagged Transactions Table (dynamodb)
 *
 * Sample code: each part does one small, real thing with a connected service, so you can see the
 * architecture working (scripts/smoke-test.sh exercises it). Replace the samples with your own logic.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';
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

// ---------------------------------------------------------------- HTTP API
/** Path prefix this function serves (the API is shared, so its routes are under /query-function). */
const PREFIX = '/query-function';
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
    return json(200, { ok: true, function: 'query-function' });
  }],
  ['POST', '/flagged-table', async (req) => {
    const id = randomUUID();
    const item = { ...asObject(req.body), pk: `ITEM#${id}`, sk: 'ITEM', id, createdAt: new Date().toISOString() };
    await putFlaggedTransactionsTable(item);
    return json(201, item);
  }],
  ['GET', '/flagged-table/{id}', async (req) => {
    const item = await getFlaggedTransactionsTable(`ITEM#${req.params.id}`, 'ITEM');
    return item ? json(200, item) : json(404, { message: 'Not found' });
  }],
  ['DELETE', '/flagged-table/{id}', async (req) => {
    await deleteFlaggedTransactionsTable(`ITEM#${req.params.id}`, 'ITEM');
    return json(204);
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
