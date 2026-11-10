import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, parseFlaggedQuery } from './index';

const parse = (query: Record<string, string | undefined>) => {
  const result = parseFlaggedQuery(query);
  if ('error' in result) throw new Error(result.error);
  return result;
};

const event = (method: string, path: string, query?: Record<string, string>): APIGatewayProxyEventV2 =>
  ({ rawPath: path, queryStringParameters: query, isBase64Encoded: false, requestContext: { http: { method } } }) as unknown as APIGatewayProxyEventV2;
const call = async (method: string, path: string, query?: Record<string, string>) =>
  (await handler(event(method, path, query))) as { statusCode: number; body?: string };

describe('parseFlaggedQuery: valid input', () => {
  it('uses a limit of 20, offset 0 and no filters by default', () => {
    expect(parse({})).toEqual({ filters: {}, limit: 20, offset: 0 });
  });

  it('reads the risk score filter', () => {
    expect(parse({ minRiskScore: '0.8' }).filters.minRiskScore).toBe(0.8);
    expect(parse({ minRiskScore: '0' }).filters.minRiskScore).toBe(0);
    expect(parse({ minRiskScore: '1' }).filters.minRiskScore).toBe(1);
  });

  it('turns a start date into the start of that day', () => {
    expect(parse({ startDate: '2026-10-30' }).filters.startDate).toBe('2026-10-30T00:00:00.000Z');
  });

  it('turns an end date on its own into the end of that day', () => {
    expect(parse({ endDate: '2026-10-30' }).filters.endDate).toBe('2026-10-30T23:59:59.999Z');
  });

  it('keeps an exact end time', () => {
    expect(parse({ endDate: '2026-10-30T09:00:00Z' }).filters.endDate).toBe('2026-10-30T09:00:00.000Z');
  });

  it('reads the merchant, limit and offset', () => {
    const parsed = parse({ merchantId: 'm-9', limit: '5', offset: '10' });
    expect(parsed.filters.merchantId).toBe('m-9');
    expect(parsed.limit).toBe(5);
    expect(parsed.offset).toBe(10);
  });

  it('allows the smallest and largest limits', () => {
    expect(parse({ limit: '1' }).limit).toBe(1);
    expect(parse({ limit: '100' }).limit).toBe(100);
  });
});

describe('parseFlaggedQuery: invalid input', () => {
  const bad: Record<string, string>[] = [
    { minRiskScore: 'high' },
    { minRiskScore: '' },
    { minRiskScore: '-0.1' },
    { minRiskScore: '1.5' },
    { startDate: 'yesterday' },
    { endDate: 'nope' },
    { merchantId: '   ' },
    { limit: '0' },
    { limit: '101' },
    { limit: '2.5' },
    { limit: 'many' },
    { offset: '-1' },
    { offset: '1.5' },
  ];
  it.each(bad)('rejects %j', (query) => {
    expect('error' in parseFlaggedQuery(query)).toBe(true);
  });
});

describe('query handler (requests that never reach AWS)', () => {
  it('answers the health check', async () => {
    expect((await call('GET', '/query-function/health')).statusCode).toBe(200);
  });

  it('rejects a bad filter with a clear message', async () => {
    const res = await call('GET', '/query-function/flagged', { minRiskScore: 'high' });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '{}').message).toBe('minRiskScore must be a number between 0 and 1');
  });

  it('lists GET /flagged among the routes for an unknown path', async () => {
    const res = await call('GET', '/query-function/nothing');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}').routes).toContain('GET /query-function/flagged');
  });
});
