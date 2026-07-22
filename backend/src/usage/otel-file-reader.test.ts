import { describe, it, expect } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUsageEvents } from './otel-file-reader.js';
import { usageDefaults } from './config.js';

function chatSpanLine(model: string, cost: number): string {
  return JSON.stringify({
    type: 'span',
    name: `chat ${model}`,
    startTime: [10, 0],
    endTime: [12, 0],
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'github',
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'github.copilot.cost': cost,
    },
    resource: { attributes: { 'feature.id': 'f1', 'session.id': 's1' } },
  });
}

describe('otel-file-reader', () => {
  it('reads only included chat spans and assigns turn indices', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'usage-'));
    const file = join(dir, 'usage.jsonl');
    const content = [
      chatSpanLine('gpt-5.4-mini', 0.33),
      '',
      JSON.stringify({ type: 'span', attributes: { 'gen_ai.operation.name': 'invoke_agent' }, resource: { attributes: {} } }),
      JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage', dataPoints: [] }),
      'garbage line',
      chatSpanLine('gpt-5.4', 1),
    ].join('\n');
    await writeFile(file, content, 'utf8');

    const events = await readUsageEvents(file, usageDefaults);
    await rm(dir, { recursive: true, force: true });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ turnIndex: 0, resolvedModel: 'gpt-5.4-mini', cost: 0.33 });
    expect(events[1]).toMatchObject({ turnIndex: 1, resolvedModel: 'gpt-5.4', cost: 1 });
  });

  it('returns an empty list when the file does not exist', async () => {
    const events = await readUsageEvents(
      join(tmpdir(), 'does-not-exist-xyz.jsonl'),
      usageDefaults,
    );
    expect(events).toEqual([]);
  });

  it('supports an injected reader', async () => {
    const events = await readUsageEvents(
      'virtual',
      usageDefaults,
      async () => chatSpanLine('gpt-5.4-mini', 0.5),
    );
    expect(events).toHaveLength(1);
    expect(events[0].cost).toBe(0.5);
  });
});
