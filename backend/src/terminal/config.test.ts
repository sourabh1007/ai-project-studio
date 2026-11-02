import { describe, expect, it } from 'vitest';
import { terminalConfigSchema, terminalDefaults } from './config.js';

describe('terminal config replay geometry bound', () => {
  it('defaults to 128', () => {
    expect(terminalDefaults.maxReplayGeometryBoundaries).toBe(128);
    expect(terminalConfigSchema.parse(terminalDefaults).maxReplayGeometryBoundaries).toBe(128);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %s', (value) => {
    expect(terminalConfigSchema.safeParse({ ...terminalDefaults, maxReplayGeometryBoundaries: value }).success).toBe(false);
  });

  it('accepts a positive integer', () => {
    expect(terminalConfigSchema.parse({ ...terminalDefaults, maxReplayGeometryBoundaries: 4 }).maxReplayGeometryBoundaries).toBe(4);
  });
});
