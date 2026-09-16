import { describe, it, expect } from 'vitest';
import { createAgentService } from './agent-service.js';
import type { AgentAttachmentRepo } from './agent-attachment-repo-port.js';
import type { AgentRegistry } from './agent-registry.js';
import type { AgentUsageReader } from './agent-usage-reader-port.js';
import type { AgentAttachment, AgentDefinition, AgentPrerequisiteResult } from './agent-contract.js';

function inMemoryRepo(): AgentAttachmentRepo {
  const rows: AgentAttachment[] = [];
  const backfilled = new Set<string>();
  return {
    create: (attachment) => { rows.push({ ...attachment }); },
    get: (id) => rows.find((r) => r.id === id) ?? null,
    listByFeature: (featureId) => rows.filter((r) => r.featureId === featureId),
    listAll: () => [...rows],
    countByAgentAndFeature: (agentId, featureId) =>
      rows.filter((r) => r.agentId === agentId && r.featureId === featureId).length,
    delete: (id) => {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
    },
    deleteByFeature: (featureId) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i]!.featureId === featureId) rows.splice(i, 1);
      }
    },
    isBackfilled: (key) => backfilled.has(key),
    markBackfilled: (key) => { backfilled.add(key); },
  };
}

function agent(
  id: string,
  opts: {
    allowMultiple?: boolean;
    prerequisite?: (featureId: string) => AgentPrerequisiteResult;
    prerequisiteLabel?: string;
    usageLabel?: string;
  } = {},
): AgentDefinition {
  return {
    manifest: {
      id,
      title: `Agent ${id}`,
      description: '',
      icon: 'icon',
      allowMultiplePerFeature: opts.allowMultiple ?? false,
      prerequisiteLabel: opts.prerequisiteLabel ?? 'a thing',
      usageLabel: opts.usageLabel ?? id,
      promptFields: [],
    },
    checkPrerequisite: opts.prerequisite ?? (() => ({ met: true })),
  };
}

function registryOf(...defs: AgentDefinition[]): AgentRegistry {
  const byId = new Map(defs.map((d) => [d.manifest.id, d]));
  return { list: () => defs, get: (id) => byId.get(id) ?? null };
}

function usageReader(map: Record<string, { credits: number | null; nanoAiu: number | null; runs: number }>): AgentUsageReader {
  return { aggregateByLabel: (label) => map[label] ?? { credits: null, nanoAiu: null, runs: 0 } };
}

function service(opts: {
  registry: AgentRegistry;
  usage?: AgentUsageReader;
  attachments?: AgentAttachmentRepo;
}) {
  let n = 0;
  const attachments = opts.attachments ?? inMemoryRepo();
  const svc = createAgentService({
    registry: opts.registry,
    attachments,
    usage: opts.usage ?? usageReader({}),
    clock: { isoNow: () => '2026-01-01T00:00:00.000Z' },
    newId: () => `att-${(n += 1)}`,
  });
  return { svc, attachments };
}

describe('agent-service', () => {
  it('lists the catalog with rolled-up average credits and reach', () => {
    const { svc } = service({
      registry: registryOf(agent('a', { usageLabel: 'A' })),
      usage: usageReader({ A: { credits: 30, nanoAiu: 3, runs: 3 } }),
    });
    svc.attach('f1', 'a');
    const [item] = svc.listCatalog();
    expect(item!.usage).toEqual({ totalCredits: 30, runs: 3, averageCredits: 10 });
    expect(item!.attachmentCount).toBe(1);
  });

  it('reports null average when there are no runs or no credits', () => {
    const { svc } = service({
      registry: registryOf(agent('a', { usageLabel: 'A' }), agent('b', { usageLabel: 'B' })),
      usage: usageReader({ B: { credits: null, nanoAiu: null, runs: 2 } }),
    });
    const items = svc.listCatalog();
    expect(items[0]!.usage).toEqual({ totalCredits: null, runs: 0, averageCredits: null });
    expect(items[1]!.usage).toEqual({ totalCredits: null, runs: 2, averageCredits: null });
  });

  it('gets one catalog item and throws for an unknown id', () => {
    const { svc } = service({ registry: registryOf(agent('a')) });
    expect(svc.getCatalogItem('a').manifest.id).toBe('a');
    expect(() => svc.getCatalogItem('nope')).toThrow(/Unknown agent/);
  });

  it('attaches an agent and lists it back on the feature', () => {
    const { svc } = service({ registry: registryOf(agent('a')) });
    const attachment = svc.attach('f1', 'a');
    expect(attachment).toMatchObject({ id: 'att-1', agentId: 'a', featureId: 'f1' });
    const attached = svc.attachedAgents('f1');
    expect(attached).toHaveLength(1);
    expect(attached[0]!.manifest.id).toBe('a');
  });

  it('drops attachments whose agent is no longer registered', () => {
    const { svc, attachments } = service({ registry: registryOf(agent('a')) });
    attachments.create({ id: 'orphan', agentId: 'gone', featureId: 'f1', createdAt: 'x' });
    expect(svc.attachedAgents('f1')).toEqual([]);
  });

  it('reports availability with block reasons', () => {
    const { svc } = service({
      registry: registryOf(
        agent('single'),
        agent('needs', {
          prerequisite: () => ({ met: false, reason: 'no review' }),
        }),
        agent('noreason', {
          prerequisite: () => ({ met: false }),
          prerequisiteLabel: 'a widget',
        }),
      ),
    });
    svc.attach('f1', 'single');
    const available = svc.availableAgents('f1');
    expect(available[0]).toMatchObject({ attachable: false, reason: 'Agent single is already attached to this feature.' });
    expect(available[1]).toMatchObject({ attachable: false, reason: 'no review' });
    expect(available[2]).toMatchObject({ attachable: false, reason: 'Requires a widget.' });
  });

  it('allows re-attaching an agent that permits multiple instances', () => {
    const { svc } = service({ registry: registryOf(agent('multi', { allowMultiple: true })) });
    svc.attach('f1', 'multi');
    const available = svc.availableAgents('f1');
    expect(available[0]!.attachable).toBe(true);
    expect(svc.attach('f1', 'multi').id).toBe('att-2');
  });

  it('rejects attaching an unknown agent or a blocked one', () => {
    const { svc } = service({
      registry: registryOf(agent('a', { prerequisite: () => ({ met: false, reason: 'nope' }) })),
    });
    expect(() => svc.attach('f1', 'missing')).toThrow(/Unknown agent/);
    expect(() => svc.attach('f1', 'a')).toThrow(/nope/);
  });

  it('detaches an attachment and throws for an unknown one', () => {
    const { svc } = service({ registry: registryOf(agent('a')) });
    const attachment = svc.attach('f1', 'a');
    svc.detach(attachment.id);
    expect(svc.attachedAgents('f1')).toEqual([]);
    expect(() => svc.detach('nope')).toThrow(/Unknown attachment/);
  });

  it('removes every attachment on a feature', () => {
    const { svc } = service({ registry: registryOf(agent('a', { allowMultiple: true })) });
    svc.attach('f1', 'a');
    svc.attach('f1', 'a');
    svc.attach('f2', 'a');
    svc.removeFeature('f1');
    expect(svc.attachedAgents('f1')).toEqual([]);
    expect(svc.attachedAgents('f2')).toHaveLength(1);
  });

  it('auto-attaches only eligible, unknown-safe, non-duplicate agents', () => {
    const { svc } = service({
      registry: registryOf(
        agent('ok'),
        agent('blocked', { prerequisite: () => ({ met: false }) }),
      ),
    });
    svc.autoAttach('f1', 'missing'); // unknown → no-op
    svc.autoAttach('f1', 'blocked'); // prerequisite unmet → no-op
    svc.autoAttach('f1', 'ok');
    svc.autoAttach('f1', 'ok'); // already attached (single) → no-op
    expect(svc.attachedAgents('f1').map((a) => a.manifest.id)).toEqual(['ok']);
  });

  it('backfills eligible features once and never twice', () => {
    const { svc } = service({
      registry: registryOf(
        agent('a', { prerequisite: (id) => ({ met: id === 'f1' }) }),
      ),
    });
    svc.backfillAutoAttachments('a', ['f1', 'f2']);
    expect(svc.attachedAgents('f1')).toHaveLength(1);
    expect(svc.attachedAgents('f2')).toHaveLength(0);
    // Detach then re-run: the marker prevents re-attaching.
    svc.detach(svc.attachedAgents('f1')[0]!.attachment.id);
    svc.backfillAutoAttachments('a', ['f1', 'f2']);
    expect(svc.attachedAgents('f1')).toHaveLength(0);
  });

  it('marks backfill done even when the agent is unknown', () => {
    const { svc, attachments } = service({ registry: registryOf(agent('a')) });
    svc.backfillAutoAttachments('ghost', ['f1']);
    expect(attachments.isBackfilled('auto:ghost')).toBe(true);
  });
});
