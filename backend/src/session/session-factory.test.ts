import { describe, it, expect } from 'vitest';
import { createSessionFactory } from './session-factory.js';
import { sessionDefaults } from './config.js';
import { createIdGenerator } from '../kernel/id-generator.js';
import { createClock } from '../kernel/clock.js';

describe('session-factory', () => {
  it('builds a created session with generated id, path and timestamps', () => {
    const factory = createSessionFactory({
      ids: createIdGenerator(() => 'sess-42'),
      clock: createClock(() => Date.parse('2025-01-01T00:00:00.000Z')),
      config: sessionDefaults,
    });

    const session = factory.build({
      featureId: 'feat-1',
      provider: 'copilot',
      requestedModel: 'auto',
      kind: 'dev',
      prompt: 'hi',
    });

    expect(session).toMatchObject({
      id: 'sess-42',
      featureId: 'feat-1',
      provider: 'copilot',
      requestedModel: 'auto',
      resolvedModel: null,
      status: 'created',
      kind: 'dev',
      prompt: 'hi',
      createdAt: '2025-01-01T00:00:00.000Z',
      startedAt: null,
      endedAt: null,
      exitCode: null,
    });
    expect(session.usageFilePath).toContain('sess-42.jsonl');
  });
});
