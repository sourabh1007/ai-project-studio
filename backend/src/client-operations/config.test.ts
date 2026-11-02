import { describe, expect, it } from 'vitest';
import { clientOperationsConfigSchema, clientOperationsDefaults, CLIENT_OPERATIONS_NAMESPACE } from './config.js';

describe('client-operations config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(CLIENT_OPERATIONS_NAMESPACE).toBe('clientOperations');
    expect(clientOperationsConfigSchema.parse(clientOperationsDefaults)).toEqual(clientOperationsDefaults);
  });

  it.each([
    { headerName: 'Bad Header' },
    { headerName: 'x-request-key' },
    { maxKeyLength: 63 },
    { maxKeyLength: 4 },
    { retentionMs: 0 },
    { maxRecords: 0 },
    { pruneBatch: 0 },
  ])('rejects %j', (override) => {
    expect(() => clientOperationsConfigSchema.parse({ ...clientOperationsDefaults, ...override })).toThrow();
  });
});
