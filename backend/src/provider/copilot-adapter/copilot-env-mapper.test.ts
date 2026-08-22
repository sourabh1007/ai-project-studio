import { describe, it, expect } from 'vitest';
import { buildCopilotEnv } from './copilot-env-mapper.js';
import type { SessionSpec } from '../provider-contract.js';

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'p',
  model: 'auto',
  kind: 'meta',
  otelFilePath: '/tmp/usage.jsonl',
};

describe('copilot-env-mapper', () => {
  it('sets OTel export + resource attributes and preserves base env', () => {
    const env = buildCopilotEnv(spec, { PATH: '/bin', EMPTY: undefined });
    expect(env.PATH).toBe('/bin');
    expect(env.EMPTY).toBeUndefined();
    expect(env.COPILOT_OTEL_ENABLED).toBe('true');
    expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/usage.jsonl');
    expect(env.STUDIO_SESSION_ID).toBe('sess-1');
    expect(env.STUDIO_FEATURE_ID).toBe('feat-1');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'feature.id=feat-1,session.id=sess-1,cw.session.kind=meta',
    );
  });
});
