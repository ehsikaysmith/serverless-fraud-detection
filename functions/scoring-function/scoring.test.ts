import { describe, expect, it } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import { exceedsVelocity, handler, scoreTransaction } from './index';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const START = Date.parse('2026-10-30T10:00:00.000Z');
const at = (minutes: number) => START + minutes * MINUTE;

const tx = (amount: number) => ({
  transactionId: 't-1',
  cardId: 'card-1',
  amount,
  merchantId: 'm-1',
  location: 'Lagos',
  timestamp: '2026-10-30T10:00:00.000Z',
});

describe('scoreTransaction: amount rules', () => {
  it('does not flag a normal amount', () => {
    const scored = scoreTransaction(tx(100));
    expect(scored.riskScore).toBe(0);
    expect(scored.rulesFired).toEqual([]);
    expect(scored.flagged).toBe(false);
  });

  it('does not flag an amount just below the threshold', () => {
    expect(scoreTransaction(tx(4999.99)).flagged).toBe(false);
  });

  it('flags an amount at the threshold as HIGH_AMOUNT', () => {
    const scored = scoreTransaction(tx(5000));
    expect(scored.rulesFired).toEqual(['HIGH_AMOUNT']);
    expect(scored.riskScore).toBe(0.6);
    expect(scored.flagged).toBe(true);
  });

  it('keeps HIGH_AMOUNT up to just below five times the threshold', () => {
    expect(scoreTransaction(tx(24999)).rulesFired).toEqual(['HIGH_AMOUNT']);
  });

  it('scores five times the threshold as VERY_HIGH_AMOUNT', () => {
    const scored = scoreTransaction(tx(25000));
    expect(scored.rulesFired).toEqual(['VERY_HIGH_AMOUNT']);
    expect(scored.riskScore).toBe(0.9);
  });

  it('keeps the original transaction fields', () => {
    const scored = scoreTransaction(tx(9500));
    expect(scored.transactionId).toBe('t-1');
    expect(scored.cardId).toBe('card-1');
    expect(scored.amount).toBe(9500);
  });
});

describe('scoreTransaction: velocity and combined rules', () => {
  it('flags a busy card even for a small amount', () => {
    const scored = scoreTransaction(tx(50), { highVelocity: true });
    expect(scored.rulesFired).toEqual(['HIGH_VELOCITY']);
    expect(scored.riskScore).toBe(0.7);
    expect(scored.flagged).toBe(true);
  });

  it('adds 0.1 when a second rule also fires, with no rounding error', () => {
    const scored = scoreTransaction(tx(9500), { highVelocity: true });
    expect(scored.rulesFired).toEqual(['HIGH_AMOUNT', 'HIGH_VELOCITY']);
    expect(scored.riskScore).toBe(0.8);
  });

  it('never goes above 1', () => {
    expect(scoreTransaction(tx(25000), { highVelocity: true }).riskScore).toBe(1);
  });

  it('does nothing extra when the velocity signal is off', () => {
    expect(scoreTransaction(tx(50), { highVelocity: false }).flagged).toBe(false);
  });
});

describe('exceedsVelocity', () => {
  it('is true for more than 5 transactions within an hour', () => {
    const times = [0, 1, 2, 3, 4, 5].map(at);
    expect(exceedsVelocity(times, at(5), 5, HOUR)).toBe(true);
  });

  it('is false for exactly 5 transactions', () => {
    const times = [0, 1, 2, 3, 4].map(at);
    expect(exceedsVelocity(times, at(4), 5, HOUR)).toBe(false);
  });

  it('is false when 6 transactions are spread over more than an hour', () => {
    const times = [0, 20, 40, 60, 80, 100].map(at);
    expect(exceedsVelocity(times, at(100), 5, HOUR)).toBe(false);
  });

  it('counts transactions exactly one hour apart', () => {
    expect(exceedsVelocity([0, 10, 20, 30, 40, 60].map(at), at(0), 5, HOUR)).toBe(true);
    expect(exceedsVelocity([0, 10, 20, 30, 40, 61].map(at), at(0), 5, HOUR)).toBe(false);
  });

  it('gives the same answer whatever order the messages arrive in', () => {
    expect(exceedsVelocity([9, 1, 5, 3, 7, 2].map(at), at(9), 5, HOUR)).toBe(true);
    expect(exceedsVelocity([2, 7, 3, 5, 1, 9].map(at), at(9), 5, HOUR)).toBe(true);
  });

  it('ignores a burst that happened hours away from this transaction', () => {
    const times = [0, 1, 2, 3, 4, 5].map(at);
    expect(exceedsVelocity(times, at(180), 5, HOUR)).toBe(false);
  });

  it('is false when there is no history', () => {
    expect(exceedsVelocity([], START, 5, HOUR)).toBe(false);
  });
});

describe('scoring handler (messages that never reach AWS)', () => {
  const sqsEvent = (...bodies: string[]) =>
    ({ Records: bodies.map((body, i) => ({ body, messageId: `m${i + 1}` })) }) as unknown as SQSEvent;

  it('sends a message that is not a transaction back for retry', async () => {
    const result = await handler(sqsEvent(JSON.stringify({ hello: 'world' })));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('sends a message that is not JSON back for retry', async () => {
    const result = await handler(sqsEvent('not json'));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('rejects a transaction with a negative amount', async () => {
    const result = await handler(sqsEvent(JSON.stringify({ ...tx(-5) })));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });

  it('reports each bad message on its own', async () => {
    const result = await handler(sqsEvent('nope', JSON.stringify({ a: 1 })));
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }, { itemIdentifier: 'm2' }]);
  });
});
