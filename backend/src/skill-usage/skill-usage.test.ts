import { describe, expect, it, vi } from 'vitest';
import { recordIdeSkillContext, skillInvocationFromEvent } from './skill-usage.js';
import { SKILL_USAGE_NAMESPACE, skillUsageConfigSchema, skillUsageDefaults } from './config.js';
import type { Skill } from '../skills/skills-contract.js';
import type { Session } from '../session/session-contract.js';

const timestamp = '2026-10-17T10:00:00.000Z';
const event = (data: Record<string, unknown> = {}) => ({
  id: 'e1', type: 'skill.invoked', timestamp,
  data: { name: 'review', path: 'C:\\worktree\\.github\\skills\\review\\SKILL.md', source: 'project', ...data },
});
const session: Session = {
  id: 's1', featureId: 'f1', provider: 'agency', kind: 'dev', status: 'created', name: null,
  requestedModel: 'auto', resolvedModel: null, prompt: '', usageFilePath: '', createdAt: timestamp,
  startedAt: null, endedAt: null, exitCode: null,
};
const skill: Skill = {
  id: 'k1', name: 'Testing', kind: 'instruction', instructions: 'Write tests', removalInstructions: '',
  recommendedScope: 'any', createdAt: timestamp,
};

describe('skill telemetry', () => {
  it('owns a bounded module configuration', () => {
    expect(SKILL_USAGE_NAMESPACE).toBe('skillUsage');
    expect(skillUsageConfigSchema.parse(skillUsageDefaults)).toEqual({ maxEvents: 5000 });
    expect(skillUsageConfigSchema.safeParse({ maxEvents: 10001 }).success).toBe(false);
  });
  it.each(['project', 'repository', 'repo', 'workspace'])('identifies explicit repository provenance %s and normalizes worktree identity', (source) => {
    expect(skillInvocationFromEvent(event({ source }))).toEqual({
      eventId: 'e1', identity: '.github/skills/review/SKILL.md', name: 'review',
      source: 'repository', kind: 'invocation', recordedAt: timestamp,
      inputTokens: null, outputTokens: null, nanoAiu: null,
    });
  });
  it.each(['plugin', 'personal', 'user', 'builtin', 'built-in', 'global'])('separates CLI provenance %s from repository and IDE skills', (source) => {
    expect(skillInvocationFromEvent(event({ source }))?.source).toBe('cli');
  });
  it('does not guess unknown provenance from a familiar skill name or path', () => {
    expect(skillInvocationFromEvent(event({ source: undefined }))?.source).toBe('unknown');
    expect(skillInvocationFromEvent(event({ source: 'future' }))?.source).toBe('unknown');
    expect(skillInvocationFromEvent(event({ path: '/project/custom/skill.md' }))?.identity).toBe('/project/custom/skill.md');
  });
  it('accepts only explicit attributed usage and preserves zero without reading contents or session totals', () => {
    const input = event({ usage: { inputTokens: 0, outputTokens: 25, nanoAiu: 2e9 },
      inputTokens: 999, content: 'private instructions', sessionTotals: { inputTokens: 99999 } });
    expect(skillInvocationFromEvent(input)).toMatchObject({ inputTokens: 0, outputTokens: 25, nanoAiu: 2e9 });
    expect(JSON.stringify(skillInvocationFromEvent(input))).not.toContain('private');
    expect(skillInvocationFromEvent(event({ usage: [] }))?.nanoAiu).toBeNull();
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '10', null])('rejects unusable attributed metrics %s', (value) => {
    expect(skillInvocationFromEvent(event({ usage: { inputTokens: value, outputTokens: value, nanoAiu: value } })))
      .toMatchObject({ inputTokens: null, outputTokens: null, nanoAiu: null });
  });
  it.each([
    null, [], 1, {}, { ...event(), type: 'tool.execution_start' }, { ...event(), id: '' },
    { ...event(), id: 7 }, { ...event(), id: 'x'.repeat(2049) }, { ...event(), id: 'a\nb' },
    { ...event(), timestamp: 1 }, { ...event(), timestamp: 'bad' },
    { ...event(), data: null }, { ...event(), data: [] }, event({ name: '' }), event({ path: '' }),
  ])('ignores malformed or unrelated events: %j', (value) => {
    expect(skillInvocationFromEvent(value)).toBeNull();
  });
  it('records only nonempty instruction contexts, separately from invocations and from internal sessions', () => {
    const record = vi.fn();
    recordIdeSkillContext({ record }, session, [skill, { ...skill, id: 'plan', kind: 'task-plan' }, { ...skill, id: 'empty', instructions: '  ' }], {
      repoId: 'r1', recordedAt: timestamp, kind: 'context-prepared', deliveryId: 's1',
    });
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith({
      eventId: '["context-prepared","s1","k1"]', featureId: 'f1', sessionId: 's1',
      provider: 'agency', repoId: 'r1', identity: 'k1', name: 'Testing', source: 'ide',
      kind: 'context-prepared', scope: 'feature', recordedAt: timestamp,
      inputTokens: null, outputTokens: null, nanoAiu: null,
    });
    recordIdeSkillContext({ record }, { ...session, scope: 'internal' }, [skill], {
      repoId: null, recordedAt: timestamp, kind: 'context-injected', deliveryId: 'delivery',
    });
    expect(record).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'internal', kind: 'context-injected' }));
  });
});
