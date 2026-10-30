import { describe, expect, it } from 'vitest';
import { handler } from './index';

describe('Transaction Ingest', () => {
  it('answers GET /ingest-function/health', async () => {
    expect(await handler({ rawPath: '/ingest-function/health', requestContext: { http: { method: 'GET' } }, isBase64Encoded: false } as never)).toMatchObject({ statusCode: 200 });
  });

  it('says which routes exist for an unknown path', async () => {
    const res = (await handler({ rawPath: '/ingest-function/nope', requestContext: { http: { method: 'GET' } }, isBase64Encoded: false } as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).routes).toContain('GET /ingest-function/health');
  });

  it('rejects a body that is not JSON', async () => {
    expect(await handler({ rawPath: '/ingest-function/health', requestContext: { http: { method: 'POST' } }, isBase64Encoded: false, body: 'not json' } as never)).toMatchObject({ statusCode: 400 });
  });
});
