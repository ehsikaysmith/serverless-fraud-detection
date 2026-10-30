import { describe, expect, it } from 'vitest';
import { handler } from './index';

describe('Query Flagged Transactions', () => {
  it('answers GET /query-function/health', async () => {
    expect(await handler({ rawPath: '/query-function/health', requestContext: { http: { method: 'GET' } }, isBase64Encoded: false } as never)).toMatchObject({ statusCode: 200 });
  });

  it('says which routes exist for an unknown path', async () => {
    const res = (await handler({ rawPath: '/query-function/nope', requestContext: { http: { method: 'GET' } }, isBase64Encoded: false } as never)) as { statusCode: number; body: string };
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).routes).toContain('GET /query-function/health');
  });

  it('rejects a body that is not JSON', async () => {
    expect(await handler({ rawPath: '/query-function/health', requestContext: { http: { method: 'POST' } }, isBase64Encoded: false, body: 'not json' } as never)).toMatchObject({ statusCode: 400 });
  });
});
