import { describe, expect, it } from 'vitest';
import { handler } from './index';

describe('Fraud Scoring Engine', () => {
  it('handles an event with nothing to do', async () => {
    await handler({ Records: [] } as never);
  });

  it('stops passing a sample on after 3 hops (no AWS calls)', async () => {
    const sample = { sample: true, runId: 'test', hops: 3 };
    await handler({ Records: [{ messageId: '1', body: JSON.stringify(sample) }] } as never);
  });
});
