import type { Skill } from '../skills/skills-contract.js';
import type { Session } from '../session/session-contract.js';
import type { SkillOrigin, SkillUsageRecord, SkillUsageRepo } from './skill-usage-contract.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 2048
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function metric(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Reads public invocation metadata only, never skill contents or tool payloads. */
export function skillInvocationFromEvent(value: unknown) {
  const event = object(value);
  if (event?.type !== 'skill.invoked' || !identifier(event.id) || typeof event.timestamp !== 'string'
    || !Number.isFinite(Date.parse(event.timestamp))) return null;
  const data = object(event.data);
  if (!data || !identifier(data.name) || !identifier(data.path)) return null;
  const source: SkillOrigin = ['project', 'repository', 'repo', 'workspace'].includes(String(data.source)) ? 'repository'
    : ['plugin', 'personal', 'user', 'builtin', 'built-in', 'global'].includes(String(data.source)) ? 'cli' : 'unknown';
  const path = data.path.replace(/\\/g, '/');
  const relative = path.match(/(?:^|\/)(\.(?:github|agents|claude)\/skills\/.+)$/)?.[1];
  // Worktree copies of a repository skill share an identity within that repo.
  const identity = source === 'repository' ? relative ?? path : path;
  const usage = object(data.usage);
  return {
    eventId: event.id, identity, name: data.name, source,
    kind: 'invocation' as const, recordedAt: new Date(event.timestamp).toISOString(),
    inputTokens: metric(usage?.inputTokens), outputTokens: metric(usage?.outputTokens),
    nanoAiu: metric(usage?.nanoAiu),
  };
}

/** IDE guidance delivery is not counted as a CLI skill invocation. */
export function recordIdeSkillContext(
  repo: Pick<SkillUsageRepo, 'record'>,
  session: Session,
  skills: readonly Skill[],
  context: { repoId: string | null; recordedAt: string; kind: 'context-prepared' | 'context-injected'; deliveryId: string },
): void {
  for (const skill of skills) {
    if (skill.kind !== 'instruction' || !skill.instructions.trim()) continue;
    const entry: SkillUsageRecord = {
      eventId: JSON.stringify([context.kind, context.deliveryId, skill.id]),
      featureId: session.featureId, sessionId: session.id, provider: session.provider,
      repoId: context.repoId, identity: skill.id, name: skill.name, source: 'ide',
      kind: context.kind, scope: session.scope === 'internal' ? 'internal' : 'feature',
      recordedAt: context.recordedAt, inputTokens: null, outputTokens: null, nanoAiu: null,
    };
    repo.record(entry);
  }
}
