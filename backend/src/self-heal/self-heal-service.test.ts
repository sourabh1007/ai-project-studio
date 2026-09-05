import { describe, expect, it, vi } from 'vitest';
import { createSelfHealService } from './self-heal-service.js';
import type { HealEvent, Healer, HealTargetInfo } from './self-heal-contract.js';

function info(id = 'gh'): HealTargetInfo {
  return { id, title: 'GitHub CLI', description: 'd', strategy: 'install' };
}

function collect(): {
  onEvent: (e: HealEvent) => void;
  events: HealEvent[];
} {
  const events: HealEvent[] = [];
  return { onEvent: (e) => events.push(e), events };
}

describe('createSelfHealService', () => {
  it('lists the registered target infos', () => {
    const healer: Healer = {
      info: info(),
      verify: vi.fn(),
      heal: vi.fn(),
    };
    const svc = createSelfHealService({ healers: [healer] });
    expect(svc.list()).toEqual([info()]);
  });

  it('reports an unknown target as an error', async () => {
    const svc = createSelfHealService({ healers: [] });
    const { onEvent, events } = collect();
    const ok = await svc.heal('nope', onEvent);
    expect(ok).toBe(false);
    expect(events).toEqual([
      { kind: 'phase', phase: 'error' },
      { kind: 'error', message: 'Unknown heal target: nope' },
    ]);
  });

  it('skips healing when already verified', async () => {
    const heal = vi.fn();
    const svc = createSelfHealService({
      healers: [{ info: info(), verify: vi.fn().mockResolvedValue(true), heal }],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(true);
    expect(heal).not.toHaveBeenCalled();
    expect(events).toContainEqual({ kind: 'phase', phase: 'checking' });
    expect(events.at(-1)).toEqual({
      kind: 'done',
      healed: true,
      message: 'GitHub CLI is already working.',
    });
  });

  it('reports a pre-check failure as an error', async () => {
    const svc = createSelfHealService({
      healers: [
        {
          info: info(),
          verify: vi.fn().mockRejectedValue(new Error('boom')),
          heal: vi.fn(),
        },
      ],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'boom' });
  });

  it('heals then re-verifies successfully, streaming logs', async () => {
    const svc = createSelfHealService({
      healers: [
        {
          info: info(),
          verify: vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true),
          heal: vi.fn(async (log: (l: string) => void) => {
            log('installing…');
          }),
        },
      ],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(true);
    expect(events).toContainEqual({ kind: 'log', line: 'installing…' });
    expect(events).toContainEqual({ kind: 'phase', phase: 'healing' });
    expect(events.at(-1)).toEqual({
      kind: 'done',
      healed: true,
      message: 'GitHub CLI is now working.',
    });
  });

  it('reports a heal failure as an error (non-Error value)', async () => {
    const svc = createSelfHealService({
      healers: [
        {
          info: info(),
          verify: vi.fn().mockResolvedValue(false),
          heal: vi.fn().mockRejectedValue('nope-string'),
        },
      ],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'nope-string' });
  });

  it('reports a post-heal verify failure as an error', async () => {
    const svc = createSelfHealService({
      healers: [
        {
          info: info(),
          verify: vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('recheck failed')),
          heal: vi.fn().mockResolvedValue(undefined),
        },
      ],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'error', message: 'recheck failed' });
  });

  it('reports when the fix did not resolve the problem', async () => {
    const svc = createSelfHealService({
      healers: [
        {
          info: info(),
          verify: vi.fn().mockResolvedValue(false),
          heal: vi.fn().mockResolvedValue(undefined),
        },
      ],
    });
    const { onEvent, events } = collect();
    const ok = await svc.heal('gh', onEvent);
    expect(ok).toBe(false);
    expect(events.at(-1)).toEqual({
      kind: 'error',
      message: 'GitHub CLI could not be repaired automatically.',
    });
  });
});
