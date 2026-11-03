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
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

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

// ---------------------------------------------------------------- flagged transactions
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Safety cap: stop reading the table after this many pages (about 1 MB each). */
const MAX_SCAN_PAGES = 20;

export interface FlaggedFilters {
  minRiskScore?: number;
  /** ISO date and time, inclusive */
  startDate?: string;
  /** ISO date and time, inclusive */
  endDate?: string;
  merchantId?: string;
}

/**
 * Read the flagged transactions that match the filters, newest first.
 * This scans the whole table, which is fine while it is small. For a big table, add an index
 * (the design suggests one on riskScore) and use Query instead.
 */
export async function listFlaggedTransactions(filters: FlaggedFilters): Promise<{ items: Record<string, unknown>[]; truncated: boolean }> {
  const names: Record<string, string> = { '#flagged': 'flagged' };
  const values: Record<string, unknown> = { ':true': true };
  const conditions = ['#flagged = :true']; // only real flagged transactions, not the sample or test items
  if (filters.minRiskScore !== undefined) {
    names['#risk'] = 'riskScore';
    values[':minRisk'] = filters.minRiskScore;
    conditions.push('#risk >= :minRisk');
  }
  if (filters.startDate !== undefined || filters.endDate !== undefined) names['#ts'] = 'timestamp';
  if (filters.startDate !== undefined) {
    values[':start'] = filters.startDate;
    conditions.push('#ts >= :start');
  }
  if (filters.endDate !== undefined) {
    values[':end'] = filters.endDate;
    conditions.push('#ts <= :end');
  }
  if (filters.merchantId !== undefined) {
    names['#merchant'] = 'merchantId';
    values[':merchant'] = filters.merchantId;
    conditions.push('#merchant = :merchant');
  }

  const items: Record<string, unknown>[] = [];
  let startKey: Record<string, unknown> | undefined;
  let pages = 0;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: process.env.FLAGGED_TABLE_TABLE_NAME!,
        FilterExpression: conditions.join(' AND '),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []));
    startKey = res.LastEvaluatedKey;
    pages++;
  } while (startKey && pages < MAX_SCAN_PAGES);
  items.sort((a, b) => (String(a.timestamp) < String(b.timestamp) ? 1 : -1)); // newest first
  return { items, truncated: startKey !== undefined };
}

/** What the API shows for a flagged transaction: no internal keys, and the card ID is masked. */
function publicView(item: Record<string, unknown>): Record<string, unknown> {
  const { pk: _pk, sk: _sk, flagged: _flagged, cardId, ...rest } = item;
  return typeof cardId === 'string' ? { ...rest, cardId: `****${cardId.slice(-4)}` } : rest;
}

/** Check the query string of GET /flagged. */
export function parseFlaggedQuery(
  query: Record<string, string | undefined>,
): { filters: FlaggedFilters; limit: number; offset: number } | { error: string } {
  const filters: FlaggedFilters = {};
  if (query.minRiskScore !== undefined) {
    const n = Number(query.minRiskScore);
    if (query.minRiskScore.trim() === '' || !Number.isFinite(n) || n < 0 || n > 1) return { error: 'minRiskScore must be a number between 0 and 1' };
    filters.minRiskScore = n;
  }
  if (query.startDate !== undefined) {
    if (Number.isNaN(Date.parse(query.startDate))) return { error: 'startDate must be a valid date, for example 2026-10-30' };
    filters.startDate = new Date(query.startDate).toISOString();
  }
  if (query.endDate !== undefined) {
    if (Number.isNaN(Date.parse(query.endDate))) return { error: 'endDate must be a valid date, for example 2026-10-30' };
    // a date on its own (2026-10-30) means the whole of that day
    filters.endDate = /^\d{4}-\d{2}-\d{2}$/.test(query.endDate) ? `${query.endDate}T23:59:59.999Z` : new Date(query.endDate).toISOString();
  }
  if (query.merchantId !== undefined) {
    if (query.merchantId.trim() === '') return { error: 'merchantId must not be empty' };
    filters.merchantId = query.merchantId;
  }
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return { error: `limit must be a whole number from 1 to ${MAX_LIMIT}` };
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(offset) || offset < 0) return { error: 'offset must be a whole number, 0 or more' };
  return { filters, limit, offset };
}

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
  // Flagged transactions, newest first. Optional: minRiskScore, startDate, endDate, merchantId, limit, offset.
  ['GET', '/flagged', async (req) => {
    const parsed = parseFlaggedQuery(req.query);
    if ('error' in parsed) return json(400, { message: parsed.error });
    const { items, truncated } = await listFlaggedTransactions(parsed.filters);
    const page = items.slice(parsed.offset, parsed.offset + parsed.limit);
    const end = parsed.offset + page.length;
    return json(200, { total: items.length, count: page.length, items: page.map(publicView), ...(end < items.length ? { nextOffset: end } : {}), truncated });
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
