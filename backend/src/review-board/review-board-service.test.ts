import { describe, expect, it, vi } from 'vitest';
import { createClock } from '../kernel/clock.js';
import type { MetaRequest, MetaRunResult } from '../meta/meta-runner.js';
import type { PrReview } from '../pr-review/pr-review-contract.js';
import type { TemporaryPromptFileFactory } from '../repository-context/temporary-prompt-file-port.js';
import { reviewBoardDefaults } from './config.js';
import {
  createReviewBoardService,
  type ReviewBoardServiceDeps,
} from './review-board-service.js';

function step(status: PrReview['problemStatement']['status']) {
  return {
    status,
    metaSessionId: null,
    usage: null,
    failure: null,
    activity: [],
    generatedAt: null,
  };
}

const review: PrReview = {
  featureId: 'f9',
  repoId: 'r1',
  pull: { number: 42, title: 'Add caching', url: 'https://example.com/pr/42' },
  worktreePath: 'C:/work/pr-42',
  baseBranch: 'main',
  description: 'short',
  problemStatement: { ...step('ready'), content: 'p', sufficient: true },
  changeGraph: {
    ...step('ready'),
    projects: [{ id: 'p1', name: 'Cache', path: 'svc/cache.csproj' }],
    nodes: [
      {
        path: 'svc/cache.cs',
        projectId: 'p1',
        module: 'Cache',
        category: 'code',
        kind: 'changed',
        changeKind: 'modified',
        diff: '@@',
        whatItDoes: 'x',
        whatChanged: 'y',
        review: [],
      },
    ],
    edges: [],
  },
  changedFiles: 1,
  timestamps: { createdAt: '', updatedAt: '' },
};

/** A temp-prompt factory that records created content and cleanup calls. */
function fakeTemporaryPrompts(): TemporaryPromptFileFactory & {
  created: string[];
  cleaned: number;
} {
  const state = { created: [] as string[], cleaned: 0 };
  const factory: TemporaryPromptFileFactory & {
    created: string[];
    cleaned: number;
  } = {
    created: state.created,
    cleaned: 0,
    async create(content: string) {
      state.created.push(content);
      return {
        path: `C:/tmp/prompt-${state.created.length}.txt`,
        cleanup: async () => {
          factory.cleaned += 1;
        },
      };
    },
  };
  return factory;
}

/** Base deps every test starts from; individual tests override `ai`/flags. */
function baseDeps(
  overrides: Partial<ReviewBoardServiceDeps> = {},
): ReviewBoardServiceDeps {
  return {
    reviews: { get: () => review },
    config: reviewBoardDefaults,
    clock: createClock(() => Date.parse('2026-02-02T00:00:00.000Z')),
    ai: { runDetailed: vi.fn(async () => ({ text: '', sessionId: 's0' })) },
    bus: { emit: vi.fn() },
    temporaryPrompts: fakeTemporaryPrompts(),
    sleep: vi.fn(async () => {}),
    ...overrides,
  };
}

function aiReturning(text: string): {
  runDetailed: (r: MetaRequest) => Promise<MetaRunResult>;
} {
  return {
    runDetailed: vi.fn(async () => ({ text, sessionId: 's1' })),
  };
}

describe('createReviewBoardService.get', () => {
  it('derives a clean board from the feature PR review', () => {
    const service = createReviewBoardService(baseDeps());
    const board = service.get('f9');
    expect(board.featureId).toBe('f9');
    expect(board.pull.number).toBe(42);
    expect(board.model.projectType).toBe('Backend service');
    expect(board.generatedAt).toBe('2026-02-02T00:00:00.000Z');
    // Starts clean: no findings and every perspective Not-started until analyzed.
    expect(board.summary).toEqual({
      open: 0,
      blocking: 0,
      warnings: 0,
      suggestions: 0,
    });
    expect(board.perspectives.every((p) => p.findings.length === 0)).toBe(true);
    expect(board.perspectives.every((p) => p.status === 'not-started')).toBe(
      true,
    );
    expect(board.perspectives.every((p) => p.risk === 'unknown')).toBe(true);
    const problem = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(problem?.status).toBe('not-started');
  });

  it('handles a review with no changed files count', () => {
    const service = createReviewBoardService(
      baseDeps({ reviews: { get: () => ({ ...review, changedFiles: null }) } }),
    );
    expect(service.get('f9').changedFiles).toBe(0);
  });

  it('propagates a missing-review error from the port', () => {
    const boom = new Error('no review');
    const get = vi.fn(() => {
      throw boom;
    });
    const service = createReviewBoardService(baseDeps({ reviews: { get } }));
    expect(() => service.get('missing')).toThrow('no review');
  });
});

describe('createReviewBoardService.analyze', () => {
  const findingsJson = `Here you go:\n\`\`\`json
[
  {
    "perspectiveId": "security",
    "title": "Unvalidated cache key",
    "detail": "The cache key is taken from user input without validation.",
    "severity": "high",
    "evidence": [{ "source": "svc/cache.cs", "reason": "key from request", "confidence": 0.8 }]
  }
]
\`\`\``;

  it('merges AI findings on top of the deterministic board (attachment path)', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const ai = aiReturning(findingsJson);
    const service = createReviewBoardService(
      baseDeps({ ai, temporaryPrompts }),
    );
    const board = await service.analyze('f9');
    const security = board.perspectives.find((p) => p.id === 'security');
    expect(security?.findings).toHaveLength(1);
    expect(security?.status).toBe('blocked');
    expect(board.recommendation).toBe('request-changes');
    const problem = board.perspectives.find((p) => p.id === 'problem-solution');
    expect(problem?.findings.length).toBeGreaterThan(0);
    expect(temporaryPrompts.created).toHaveLength(1);
    expect(temporaryPrompts.cleaned).toBe(1);
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.attachments).toEqual(['C:/tmp/prompt-1.txt']);
  });

  it('carries the prompt inline when inlinePrompts is set (no attachment)', async () => {
    const temporaryPrompts = fakeTemporaryPrompts();
    const ai = aiReturning('```json\n[]\n```');
    const service = createReviewBoardService(
      baseDeps({ ai, temporaryPrompts, inlinePrompts: true }),
    );
    await service.analyze('f9');
    expect(temporaryPrompts.created).toHaveLength(0);
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.attachments).toBeUndefined();
    expect(request.prompt).toContain('review findings');
  });

  it('ignores AI findings for unknown perspectives', async () => {
    const ai = aiReturning(
      '```json\n[{"perspectiveId":"nope","title":"x","detail":"y","severity":"low","evidence":[{"source":"a","reason":"b"}]}]\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai }));
    const board = await service.analyze('f9');
    const extra = board.perspectives
      .flatMap((p) => p.findings)
      .filter((f) => f.id.includes('ai-'));
    expect(extra).toHaveLength(0);
  });

  it('retries a transient provider failure then succeeds', async () => {
    const runDetailed = vi
      .fn()
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))
      .mockResolvedValueOnce({ text: '```json\n[]\n```', sessionId: 's2' });
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, sleep }),
    );
    await service.analyze('f9');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-transient failure', async () => {
    const runDetailed = vi.fn().mockRejectedValue(new Error('bad prompt'));
    const service = createReviewBoardService(baseDeps({ ai: { runDetailed } }));
    await expect(service.analyze('f9')).rejects.toThrow('bad prompt');
    expect(runDetailed).toHaveBeenCalledTimes(1);
  });

  it('surfaces a non-Error thrown value', async () => {
    const runDetailed = vi.fn().mockRejectedValue('kaboom');
    const service = createReviewBoardService(baseDeps({ ai: { runDetailed } }));
    await expect(service.analyze('f9')).rejects.toBe('kaboom');
  });

  it('exhausts retries and surfaces the final transient failure', async () => {
    const runDetailed = vi.fn().mockRejectedValue(new Error('HTTP 503 error'));
    const sleep = vi.fn(async () => {});
    const service = createReviewBoardService(
      baseDeps({
        ai: { runDetailed },
        sleep,
        config: { ...reviewBoardDefaults, transientRetryAttempts: 1 },
      }),
    );
    await expect(service.analyze('f9')).rejects.toThrow('HTTP 503 error');
    expect(runDetailed).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe('createReviewBoardService.analyzePerspective', () => {
  const objectJson = `\`\`\`json
{"skipped": false, "summary": "Inspected svc/cache.cs BuildKey for tainted input.",
 "rationale": [{"label":"Problem","detail":"cache key may be tainted"},{"label":"Verdict","detail":"needs validation"}],
 "checks": [{"item":"svc/cache.cs — BuildKey","finding":"key derived from request","status":"concern"}],
 "findings": [
  {"title":"Unvalidated cache key","detail":"key from user input","severity":"high","evidence":[{"source":"svc/cache.cs","reason":"key from request","confidence":0.8}]}
]}
\`\`\``;

  it('merges AI findings into just the requested perspective', async () => {
    const ai = aiReturning(objectJson);
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.perspectiveId).toBe('security');
    expect(result.skipped).toBe(false);
    expect(result.skipReason).toBeNull();
    expect(result.summary).toBe(
      'Inspected svc/cache.cs BuildKey for tainted input.',
    );
    expect(result.rationale).toEqual([
      { label: 'Problem', detail: 'cache key may be tainted' },
      { label: 'Verdict', detail: 'needs validation' },
    ]);
    expect(result.checks).toEqual([
      {
        item: 'svc/cache.cs — BuildKey',
        finding: 'key derived from request',
        status: 'concern',
      },
    ]);
    expect(result.perspective.id).toBe('security');
    expect(result.perspective.findings).toHaveLength(1);
    expect(result.perspective.status).toBe('blocked');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Review lens');
  });

  it('reports a skipped perspective with its reason', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No configuration changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'impact-blast-radius');
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe('No configuration changed.');
  });

  it('keeps the deterministic findings when the AI adds nothing', async () => {
    const ai = aiReturning('```json\n{"skipped": false, "findings": []}\n```');
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'problem-solution');
    expect(result.perspective.findings.length).toBeGreaterThan(0);
  });

  it('uses the problem/solution prompt and floor for the problem-solution lens', async () => {
    const ai = aiReturning('```json\n{"skipped": false, "findings": []}\n```');
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'problem-solution');
    // Dedicated prompt was used (general problem/solution, not file-by-file).
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('does this pull request');
    expect(request.prompt).toContain('Do NOT evaluate files');
    expect(request.prompt).toContain('Distilled problem statement:');
    // Floor frames the fallback as Problem / Solution / Why they align / Verdict
    // with NO file-level line-by-line checks.
    expect(result.rationale.map((r) => r.label)).toEqual([
      'Problem',
      'Solution implemented',
      'Why they align',
      'Verdict',
    ]);
    expect(result.rationale[1].detail).toContain('The change spans');
    expect(result.checks).toEqual([]);
    expect(result.summary).toContain('Problem:');
  });

  it('reads the solution from the description when nothing changed resolves', async () => {
    const boundaryOnly: PrReview = {
      ...review,
      changeGraph: {
        ...review.changeGraph,
        nodes: review.changeGraph.nodes.map((n) => ({
          ...n,
          kind: 'boundary' as const,
        })),
      },
    };
    const ai = aiReturning('```json\n{"skipped": false, "findings": []}\n```');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true, reviews: { get: () => boundaryOnly } }),
    );
    const result = await service.analyzePerspective('f9', 'problem-solution');
    expect(result.rationale[1].detail).toContain(
      'No changed files were resolved',
    );
  });

  it('marks a reviewed-but-clean perspective Approved / Low', async () => {
    const ai = aiReturning('```json\n{"skipped": false, "findings": []}\n```');
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.perspective.findings).toHaveLength(0);
    expect(result.perspective.status).toBe('approved');
    expect(result.perspective.risk).toBe('low');
  });

  it('fills empty detail from the deterministic evidence floor', async () => {
    // The model returns a clean verdict with no summary/rationale/checks; the
    // service must never leave the detail panel empty for an analysed lens.
    const ai = aiReturning('```json\n{"skipped": false, "findings": []}\n```');
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.summary).not.toBeNull();
    expect(result.summary).toContain('Security');
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.rationale[0].label).toBe('Concern');
    expect(result.checks.length).toBeGreaterThan(0);
  });

  it('keeps the model detail when it is provided (floor not used)', async () => {
    const result = await createReviewBoardService(
      baseDeps({ ai: aiReturning(objectJson), inlinePrompts: true }),
    ).analyzePerspective('f9', 'security');
    expect(result.summary).toBe(
      'Inspected svc/cache.cs BuildKey for tainted input.',
    );
    expect(result.rationale).toEqual([
      { label: 'Problem', detail: 'cache key may be tainted' },
      { label: 'Verdict', detail: 'needs validation' },
    ]);
  });

  it('returns the model detail as-is for a skipped lens (no floor)', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No config changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'impact-blast-radius');
    expect(result.skipped).toBe(true);
    expect(result.summary).toBeNull();
    expect(result.rationale).toEqual([]);
    expect(result.checks).toEqual([]);
  });

  it('marks a skipped, finding-less perspective Not-applicable', async () => {
    const ai = aiReturning(
      '```json\n{"skipped": true, "reason": "No security-relevant code changed."}\n```',
    );
    const service = createReviewBoardService(baseDeps({ ai, inlinePrompts: true }));
    const result = await service.analyzePerspective('f9', 'security');
    expect(result.skipped).toBe(true);
    expect(result.perspective.status).toBe('not-applicable');
    expect(result.perspective.risk).toBe('unknown');
  });

  it('rejects an unknown perspective id', async () => {
    const service = createReviewBoardService(baseDeps({ inlinePrompts: true }));
    await expect(
      service.analyzePerspective('f9', 'ghost'),
    ).rejects.toThrow('Unknown perspective: ghost');
  });

  it('streams live activity for the perspective over the bus (inline path)', async () => {
    const emit = vi.fn();
    const runDetailed = vi.fn(async (r: MetaRequest) => {
      r.onStart?.('meta-123');
      r.onActivity?.('Reading svc/cache.cs…');
      r.onActivity?.('Assessing BuildKey…');
      return { text: objectJson, sessionId: 'meta-123' };
    });
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, bus: { emit }, inlinePrompts: true }),
    );
    await service.analyzePerspective('f9', 'security');
    // The onStart banner line plus each activity line, all tagged with the
    // metasession id and the perspective they belong to.
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Reviewer session started — reading the change evidence…',
    });
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Reading svc/cache.cs…',
    });
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-123',
      line: 'Assessing BuildKey…',
    });
  });

  it('streams live activity over the bus on the attachment (cold) path', async () => {
    const emit = vi.fn();
    const runDetailed = vi.fn(async (r: MetaRequest) => {
      r.onStart?.('meta-cold');
      r.onActivity?.('Inspecting the diff…');
      return { text: objectJson, sessionId: 'meta-cold' };
    });
    const service = createReviewBoardService(
      baseDeps({ ai: { runDetailed }, bus: { emit } }),
    );
    await service.analyzePerspective('f9', 'security');
    expect(emit).toHaveBeenCalledWith('review.board.activity', {
      featureId: 'f9',
      perspectiveId: 'security',
      sessionId: 'meta-cold',
      line: 'Inspecting the diff…',
    });
  });
});

describe('createReviewBoardService.chat', () => {
  it('answers with the trimmed completion, scoped to a perspective', async () => {
    const ai = aiReturning('  The blast radius is wide.  ');
    const service = createReviewBoardService(baseDeps({ ai }));
    const reply = await service.chat('f9', 'impact-blast-radius', [
      { role: 'user', content: 'Why is this risky?' },
    ]);
    expect(reply.answer).toBe('The blast radius is wide.');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('attached file');
  });

  it('answers a board-wide question when perspectiveId is null', async () => {
    const ai = aiReturning('Overall it needs review.');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', null, [
      { role: 'user', content: 'Summarize.' },
    ]);
    expect(reply.answer).toBe('Overall it needs review.');
    const request = (ai.runDetailed as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as MetaRequest;
    expect(request.prompt).toContain('Engineering Review Agent');
  });

  it('tolerates a perspectiveId that is not on the board', async () => {
    const ai = aiReturning('n/a');
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', 'ghost', [
      { role: 'user', content: 'Hi' },
    ]);
    expect(reply.answer).toBe('n/a');
    expect(reply.ratingChange).toBeNull();
  });

  it('surfaces a convinced rating change for the focused perspective', async () => {
    const ai = aiReturning(
      'You are right — svc/cache.cs BuildKey bounds growth.\n' +
        '```json\n' +
        '{"status":"approved","risk":"low","summary":"Re-checked BuildKey.",' +
        '"rationale":[{"label":"Evidence","detail":"cap at svc/cache.cs:42"}],' +
        '"justification":"You showed the cap at line 42."}\n' +
        '```',
    );
    const service = createReviewBoardService(
      baseDeps({ ai, inlinePrompts: true }),
    );
    const reply = await service.chat('f9', 'security', [
      { role: 'user', content: 'The cap at line 42 bounds it.' },
    ]);
    expect(reply.answer).toBe(
      'You are right — svc/cache.cs BuildKey bounds growth.',
    );
    expect(reply.ratingChange).toEqual({
      perspectiveId: 'security',
      status: 'approved',
      risk: 'low',
      summary: 'Re-checked BuildKey.',
      rationale: [{ label: 'Evidence', detail: 'cap at svc/cache.cs:42' }],
      justification: 'You showed the cap at line 42.',
    });
  });
});
