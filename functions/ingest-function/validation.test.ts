import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, validateTransaction } from './index';

const valid = { cardId: 'card-123', amount: 9500, merchantId: 'm-1', location: 'Lagos', timestamp: '2026-10-30T10:00:00Z' };

const event = (method: string, path: string, body?: string): APIGatewayProxyEventV2 =>
  ({ rawPath: path, body, isBase64Encoded: false, requestContext: { http: { method } } }) as unknown as APIGatewayProxyEventV2;
const call = async (method: string, path: string, body?: string) => (await handler(event(method, path, body))) as { statusCode: number; body?: string };

describe('validateTransaction', () => {
  it('accepts a complete transaction and gives it an ID', () => {
    const { errors, transaction } = validateTransaction(valid);
    expect(errors).toEqual([]);
    expect(transaction?.cardId).toBe('card-123');
    expect(transaction?.amount).toBe(9500);
    expect(transaction?.merchantId).toBe('m-1');
    expect(transaction?.location).toBe('Lagos');
    expect(transaction?.transactionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('writes the timestamp in one standard format', () => {
    expect(validateTransaction(valid).transaction?.timestamp).toBe('2026-10-30T10:00:00.000Z');
    expect(validateTransaction({ ...valid, timestamp: '2026-10-30' }).transaction?.timestamp).toBe('2026-10-30T00:00:00.000Z');
  });

  it('removes spaces around text fields', () => {
    const { transaction } = validateTransaction({ ...valid, cardId: '  card-123  ', location: ' Lagos ' });
    expect(transaction?.cardId).toBe('card-123');
    expect(transaction?.location).toBe('Lagos');
  });

  it('gives every transaction its own ID', () => {
    const first = validateTransaction(valid).transaction?.transactionId;
    const second = validateTransaction(valid).transaction?.transactionId;
    expect(first).toBeDefined();
    expect(first === second).toBe(false);
  });

  it.each(['cardId', 'merchantId', 'location', 'timestamp'])('rejects a missing %s', (field) => {
    const input: Record<string, unknown> = { ...valid };
    delete input[field];
    const { errors, transaction } = validateTransaction(input);
    expect(transaction).toBeUndefined();
    expect(errors).toEqual([`${field} is required and must be text`]);
  });

  it.each(['', '   ', 42, null])('rejects cardId %j', (cardId) => {
    expect(validateTransaction({ ...valid, cardId }).transaction).toBeUndefined();
  });

  it.each([0, -5, '9500', null, Infinity])('rejects amount %j', (amount) => {
    const { errors, transaction } = validateTransaction({ ...valid, amount });
    expect(transaction).toBeUndefined();
    expect(errors).toContain('amount must be a number greater than 0');
  });

  it('rejects a timestamp that is not a date', () => {
    const { errors, transaction } = validateTransaction({ ...valid, timestamp: 'yesterday' });
    expect(transaction).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it.each([undefined, null, 'text', 42])('lists every problem for a body that is %j', (body) => {
    const { errors, transaction } = validateTransaction(body);
    expect(transaction).toBeUndefined();
    expect(errors).toHaveLength(5);
  });

  it('lists every problem for a body that is a list', () => {
    const { errors, transaction } = validateTransaction([]);
    expect(transaction).toBeUndefined();
    expect(errors).toHaveLength(5);
  });
});

describe('ingest handler (requests that never reach AWS)', () => {
  it('answers the health check', async () => {
    const res = await call('GET', '/ingest-function/health');
    expect(res.statusCode).toBe(200);
  });

  it('rejects an invalid transaction with the list of problems', async () => {
    const res = await call('POST', '/ingest-function/transactions', JSON.stringify({ amount: -5, merchantId: 'm-1' }));
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body ?? '{}') as { message: string; errors: string[] };
    expect(body.message).toBe('Invalid transaction.');
    expect(body.errors).toHaveLength(4);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await call('POST', '/ingest-function/transactions', '{bad');
    expect(res.statusCode).toBe(400);
  });

  it('lists the real routes for an unknown path', async () => {
    const res = await call('GET', '/ingest-function/nothing');
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body ?? '{}').routes).toContain('POST /ingest-function/transactions');
  });
});
