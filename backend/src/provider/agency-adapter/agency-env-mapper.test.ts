import { describe, it, expect } from 'vitest';
import { buildAgencyEnv } from './agency-env-mapper.js';
import type { SessionSpec } from '../provider-contract.js';

const spec: SessionSpec = {
  sessionId: 'sess-1',
  featureId: 'feat-1',
  prompt: 'p',
  model: 'auto',
  kind: 'dev',
  otelFilePath: '/tmp/usage.jsonl',
};

describe('agency-env-mapper', () => {
  it('captures usage via the shared Copilot OTel env mapping', () => {
    const env = buildAgencyEnv(spec, { PATH: '/bin' });
    expect(env.PATH).toBe('/bin');
    expect(env.COPILOT_OTEL_ENABLED).toBe('true');
    expect(env.COPILOT_OTEL_FILE_EXPORTER_PATH).toBe('/tmp/usage.jsonl');
    expect(env.OTEL_RESOURCE_ATTRIBUTES).toBe(
      'feature.id=feat-1,session.id=sess-1,cw.session.kind=dev',
    );
  });
});
