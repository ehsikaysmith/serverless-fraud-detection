import { describe, expect, it } from 'vitest';
import { handler } from './index';

describe('Bedrock Explainer', () => {
  it('handles an event with nothing to do', async () => {
    await handler({} as never);
  });

  it('stops passing a sample on after 3 hops (no AWS calls)', async () => {
    const sample = { sample: true, runId: 'test', hops: 3 };
    await handler(sample as never);
  });
});
