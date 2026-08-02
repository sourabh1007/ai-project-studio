import { describe, expect, it } from 'vitest';
import type { MetaRequest, MetaRunner } from '../meta/meta-runner.js';
import { buildCopilotArgs } from '../provider/copilot-adapter/copilot-cmd-builder.js';
import { copilotDefaults } from '../provider/copilot-adapter/config.js';
import { createRepositoryAnalysisExecutor } from './repository-analysis-executor.js';
import type { TemporaryPromptFileFactory } from './temporary-prompt-file-port.js';

function harness(options: { metaError?: Error; createError?: Error } = {}) {
  const requests: MetaRequest[] = [];
  const created: string[] = [];
  const cleaned: string[] = [];
  const temporaryPrompts: TemporaryPromptFileFactory = {
    create: async (content, repositoryPath) => {
      if (options.createError) {
        throw options.createError;
      }
      created.push(`${repositoryPath}\n${content}`);
      return {
        path: 'C:\\Temp\\aps-a\\p.pdf',
        cleanup: async () => {
          cleaned.push('C:\\Temp\\aps-a\\p.pdf');
        },
      };
    },
  };
  const meta: MetaRunner = {
    run: async (request) => {
      requests.push(request);
      if (options.metaError) {
        throw options.metaError;
      }
      return 'repository context';
    },
  };
  return {
    executor: createRepositoryAnalysisExecutor(meta, temporaryPrompts),
    requests,
    created,
    cleaned,
  };
}

describe('repository-analysis-executor', () => {
  it('attaches the complete prompt, uses a short safe instruction, bounds output, and cleans up', async () => {
    const fullPrompt = `read-only rules\n${'evidence '.repeat(5_000)}`;
    const h = harness();

    await expect(
      h.executor.execute({
        repositoryId: 'r1',
        repositoryPath: 'C:\\work\\repo',
        prompt: fullPrompt,
        maxOutputChars: 10,
      }),
    ).resolves.toBe('repository');
    expect(h.created).toEqual([`C:\\work\\repo\n${fullPrompt}`]);
    expect(fullPrompt.length).toBeGreaterThan(32_768);
    expect(h.cleaned).toEqual(['C:\\Temp\\aps-a\\p.pdf']);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      featureId: 'repository:r1',
      attachments: ['C:\\Temp\\aps-a\\p.pdf'],
      cwd: 'C:\\work\\repo',
      scope: 'internal',
    });
    expect(h.requests[0].prompt.length).toBeLessThan(500);
    expect(h.requests[0].prompt).toContain('untrusted');
    expect(h.requests[0].prompt).not.toContain(fullPrompt);
    const args = buildCopilotArgs(
      {
        sessionId: 'session-1',
        featureId: h.requests[0].featureId,
        prompt: h.requests[0].prompt,
        attachments: h.requests[0].attachments,
        model: 'auto',
        kind: 'meta',
        otelFilePath: 'usage.jsonl',
        cwd: h.requests[0].cwd,
      },
      copilotDefaults,
    );
    expect(args.every((argument) => !argument.includes(fullPrompt))).toBe(true);
  });

  it('cleans the temporary prompt when launch or provider execution fails', async () => {
    const h = harness({ metaError: new Error('spawn failed') });
    await expect(
      h.executor.execute({
        repositoryId: 'r1',
        repositoryPath: 'C:\\work\\repo',
        prompt: 'full prompt',
        maxOutputChars: 10,
      }),
    ).rejects.toThrow('spawn failed');
    expect(h.cleaned).toEqual(['C:\\Temp\\aps-a\\p.pdf']);
  });

  it('does not invoke the provider when temporary prompt creation fails', async () => {
    const h = harness({ createError: new Error('temp unavailable') });
    await expect(
      h.executor.execute({
        repositoryId: 'r1',
        repositoryPath: 'C:\\work\\repo',
        prompt: 'full prompt',
        maxOutputChars: 10,
      }),
    ).rejects.toThrow('temp unavailable');
    expect(h.requests).toEqual([]);
    expect(h.cleaned).toEqual([]);
  });
});
