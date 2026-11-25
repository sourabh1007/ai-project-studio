import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ReviewBoard, ReviewFinding } from '../../lib/types.js';
import { ReviewOverview, ReviewShortText } from './review-overview.js';

const finding: ReviewFinding = {
  id: 'security/one', perspectiveId: 'security', title: 'Retry duplicates the charge',
  detail: 'Problem: A retry charges twice. Why: The write is not idempotent. Fix: Persist an operation key.',
  severity: 'high', status: 'blocked', skillIds: ['billing'],
  evidence: [{ source: 'src/charge.ts', reason: 'Retry writes twice', confidence: 1, direct: true,
    location: { path: 'src/charge.ts', line: 12, side: 'RIGHT' } }],
};
const second: ReviewFinding = { ...finding, id: 'business/one', perspectiveId: 'business' };

function board(): ReviewBoard {
  return {
    featureId: 'feature', problem: 'Retries must preserve one charge.', solution: 'Add a retry loop.',
    repoId: 'repo', worktreePath: 'C:\\repo', baseBranch: 'main',
    recommendation: 'request-changes', summary: { open: 2, blocking: 2, warnings: 0, suggestions: 0 },
    reviewUpdatedAt: '2026-01-01', generatedAt: '2026-01-01',
    model: {
      projectType: 'web', projectTypeConfidence: 1, confidence: 1, primaryLanguages: [],
      secondaryLanguages: [], changedComponents: [], changedModules: [], changedRuntimePaths: [],
      configurationSystems: [], testSignals: [], deploymentModel: '', contracts: [], blastRadiusDimensions: [], evidence: [],
    },
    pull: { number: 1, title: 'Retry', url: 'https://example.test/1', headSha: 'head' },
    changedFiles: 1,
    perspectives: [
      { id: 'security', name: 'Security', findings: [finding], why: 'Review access', source: 'core', status: 'blocked', risk: 'high' },
      { id: 'business', name: 'Business', findings: [second], why: 'Review rules', source: 'detected', status: 'blocked', risk: 'high' },
    ],
    uniqueFindings: [{ id: 'group-one', finding, observations: [finding, second],
      perspectiveIds: ['security', 'business'], skillIds: ['billing'] }],
    run: { id: 'run', revision: 3, status: 'completed', options: {}, providerId: 'cli', model: 'auto',
      perspectiveIds: ['security', 'business'], headSha: 'head', graphGeneratedAt: 'graph', startedAt: '2026-01-01',
      failures: {}, context: { fingerprint: 'context', evidence: 'Captured diff', businessRequirements: 'One charge per purchase.',
        warnings: [], skills: [{ id: 'billing', name: 'Billing policy', source: 'AGENTS.md',
          fingerprint: 'skill-rev', content: 'Do not double-charge.', perspectiveIds: ['business'] }] } },
  };
}

function setup(value = board(), complete = true, publications: Record<string, 'pending' | 'posted' | 'uncertain'> = {},
  extra: Partial<ComponentProps<typeof ReviewOverview>> = {}) {
  const callbacks = { onPost: vi.fn(), onDiff: vi.fn(), onDisposition: vi.fn(), onReviewDetails: vi.fn() };
  const view = render(<ReviewOverview board={value} complete={complete} running={false}
    resolutions={{}} publications={publications} {...callbacks} {...extra} />);
  return { ...callbacks, ...view };
}

function openTool(name: string) {
  fireEvent.click(screen.getByText('More tools'));
  fireEvent.click(screen.getByRole('button', { name }));
}

function walkthroughBoard() {
  const value = board();
  value.problem = 'A retry can charge the same purchase twice.';
  value.solution = 'Reuse the operation key to return the original receipt.';
  value.run!.context.evidence = JSON.stringify({ path: 'src/charge.ts',
    diff: '@@ -1 +1 @@\n-charge(newKey());\n+charge(operationKey);' });
  value.analyses = { 'problem-solution': {
    perspectiveId: 'problem-solution', perspective: { ...value.perspectives[0], id: 'problem-solution' },
    skipped: false, skipReason: null, summary: 'The retry keeps the original key.', checks: [],
    rationale: [
      { label: 'Problem example', detail: 'For example, retrying purchase 42 creates a second payment instead of returning its receipt.' },
      { label: 'Problem code', detail: 'src/charge.ts\ncharge(newKey());' },
      { label: 'Solution example', detail: 'For the same purchase 42, a retry reuses its key and returns the first receipt.' },
      { label: 'Solution code', detail: 'src/charge.ts\ncharge(operationKey);' },
    ],
  } };
  return value;
}

describe('minimal Review Board overview', () => {
  it('expands distinct simple before/after examples and exact code without repeating the summaries', async () => {
    const value = walkthroughBoard();
    setup(value);
    expect(screen.queryByText(/For example, retrying purchase 42/)).not.toBeInTheDocument();
    expect(screen.queryByText('Full explanation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    const dialog = screen.getByRole('dialog');
    expect(await screen.findByText(/For example, retrying purchase 42/)).toBeVisible();
    expect(screen.getByText('charge(newKey());')).toBeVisible();
    expect(within(dialog).getAllByText(value.problem!)).toHaveLength(1);
    expect(await screen.findByText(/For the same purchase 42/)).toBeVisible();
    expect(screen.getByText('charge(operationKey);')).toBeVisible();
    expect(within(dialog).getAllByText(value.solution!)).toHaveLength(1);
  });
  it.each(['charge(attackerKey());', 'charge(operationKey);\nrelease();'])(
    'uses captured code instead of invented or stitched model excerpts: %s', (requested) => {
    const value = walkthroughBoard();
    value.run!.context.evidence = JSON.stringify({ path: 'src/charge.ts',
      diff: '@@ -1 +1 @@\n-charge(newKey());\n+charge(operationKey);\n@@ -50 +50 @@\n-oldCleanup();\n+release();' });
    value.analyses!['problem-solution'].rationale[3].detail = `src/charge.ts\n${requested}`;
    setup(value);
    fireEvent.click(screen.getByRole('button', { name: 'Solution and changed code' }));
    const dialog = screen.getByRole('dialog');
    const excerpt = within(dialog).getByText('charge(operationKey);');
    expect(excerpt).toBeVisible();
    expect(excerpt).not.toHaveTextContent('release()');
    expect(within(dialog).queryByText('charge(operationKey); release();')).not.toBeInTheDocument();
  });
  it('does not present a duplicate problem paragraph as an explanation of the implemented solution', () => {
    const value = board();
    value.solution = value.problem;
    setup(value);
    expect(screen.getAllByText(value.problem!)).toHaveLength(1);
    expect(screen.getByText('This review did not capture a distinct explanation of the implemented fix.')).toBeVisible();
  });
  it('folds long explanations and comments without losing their rationale or evidence', () => {
    const text = 'A retry should return the original receipt. ' + 'The operation key survives repeated attempts. '.repeat(12);
    const { container } = render(<ReviewShortText text={text} detailsLabel="Full comment" />);
    expect(container.querySelector('.rb-two-line')!.textContent!.length).toBeLessThanOrEqual(180);
    expect(screen.getByText(text.trim())).not.toBeVisible();
    fireEvent.click(screen.getByText('Full comment'));
    expect(screen.getByText(text.trim())).toBeVisible();
  });
  it('keeps one concise card and opens full concern evidence through its title', () => {
    const value = board();
    const detail = 'Problem: A retry charges twice. Why: The write is not idempotent. Evidence: The insert runs for every attempt. Fix: Persist an operation key.';
    value.uniqueFindings![0].finding = { ...finding, detail };
    setup(value);
    expect(screen.queryByText('Full comment')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open diff' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Why this comment? ${finding.title}` }));
    expect(within(screen.getByRole('dialog')).getByText('The insert runs for every attempt.')).toBeVisible();
  });
  it('separates repository, IDE and shared provenance and retains cited but unavailable references', () => {
    const value = board();
    const captured = value.run!.context.skills;
    captured.push({ ...captured[0], id: 'studio:cosmos', source: 'studio:cosmos', name: 'Cosmos guidance' },
      { ...captured[0], id: 'shared:context', source: 'shared:context', name: 'Layered context' },
      { ...captured[0], id: 'unavailable', source: 'policy.md@base', name: 'Unavailable policy', content: '', contentStatus: 'unavailable' });
    value.uniqueFindings![0].skillIds.push('studio:cosmos', 'shared:context', 'unavailable');
    setup(value);
    expect(screen.queryByLabelText('Review skill provenance')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skills and related comments', hidden: true })).not.toBeVisible();
    openTool('Skills and related comments');
    expect(screen.getByText('Repo skills: 1 captured · 1 cited')).toBeVisible();
    expect(screen.getByText('IDE skills: 1 captured · 1 cited')).toBeVisible();
    expect(screen.getByText('Shared context: 1 captured · 1 cited')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Skills cited by review comments (3)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Repository skills (2)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'IDE-level skills (1)' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Shared context (1)' })).toBeVisible();
    expect(screen.getByText('Unavailable policy')).not.toBeVisible();
    fireEvent.click(screen.getByText('Other captured references (1)'));
    expect(screen.getByText('Unavailable policy')).toBeVisible();
    expect(screen.getByText('Referenced; instructions unavailable.')).toBeVisible();
  });
  it('waits for an active explanation without asking for retry, and displays it as soon as available', () => {
    const value = board();
    value.solution = 'The review has not explained the solution yet. Retry the incomplete review.';
    const callbacks = { onPost: vi.fn(), onDiff: vi.fn(), onDisposition: vi.fn(), onReviewDetails: vi.fn(), publications: {} };
    const view = render(<ReviewOverview board={value} complete={false} running={true} resolutions={{}} {...callbacks} />);
    expect(screen.getByText(/Analysing how the changes address the problem/)).toBeVisible();
    expect(screen.queryByText(/Retry the incomplete review/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    expect(within(screen.getByRole('dialog')).getByText(/Analysing how the changes address the problem/)).toBeVisible();
    const updated = { ...value, solution: 'Keep the same operation key.\n\n```text\n[Retry] -> [Original receipt]\n```' };
    view.rerender(<ReviewOverview board={updated} complete={false} running={true} resolutions={{}} {...callbacks} />);
    expect(within(screen.getByRole('dialog')).getByText('Keep the same operation key.')).toBeVisible();
    expect(within(screen.getByRole('dialog')).getByText('[Retry] -> [Original receipt]')).toBeVisible();
    expect(screen.queryByText(/Analysing how the changes address the problem/)).not.toBeInTheDocument();
  });

  it('leads with readable problem and solution diagrams, not bookkeeping or requirements cards', () => {
    const value = board();
    const before = '[Retry] -> [Second charge]';
    const after = '[Retry]\n   |\n   v\n[Same key] -> [Original receipt]';
    value.problem = `A retry could charge twice.\n\n\`\`\`text\n${before}\n\`\`\``;
    value.solution = `Keep the same operation key.\n\n\`\`\`text\n${after}\n\`\`\``;
    value.run!.context.businessRequirements = 'Reviewing 2 pull requests from Example/Repo.\nImport reference: import-1';
    setup(value);
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Why this change is needed' })).toBeVisible();
    expect(within(dialog).getByRole('heading', { name: 'How the change addresses it' })).toBeVisible();
    expect([...dialog.querySelectorAll('pre code')].map((node) => node.textContent!.trimEnd())).toEqual([before, after]);
    expect(within(dialog).queryByText(/Import reference:/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Business requirements captured for this review')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Acceptance criteria and source evidence').closest('details')).not.toHaveAttribute('open');
  });
  it('loads source-backed criteria on demand without requiring user confirmation or changing saved findings', async () => {
    const value = board();
    delete value.run;
    const contextDiscovery: NonNullable<ReviewBoard['contextDiscovery']> = {
      status: 'loaded', headSha: 'head', graphGeneratedAt: 'graph', contextFingerprint: 'context',
      generatedAt: '2026-11-02', summary: 'Retries should preserve one purchase.',
      requirements: [
        { text: 'One charge per purchase.', kind: 'documented', source: 'BUSINESS.md@base', quote: 'One charge per purchase.' },
        { text: 'Reuse the operation key.', kind: 'inferred', source: 'captured-change:context', quote: 'operationKey' },
      ], questions: ['How long are operation keys retained?'],
    };
    const loadContext = vi.fn(async () => ({ ...value, contextDiscovery }));
    setup(value, true, {}, { loadContext });
    expect(loadContext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    fireEvent.click(screen.getByText('Acceptance criteria and source evidence'));
    fireEvent.click(screen.getByRole('button', { name: 'Load context with metasession' }));
    expect(await screen.findByText('Retries should preserve one purchase.')).toBeVisible();
    expect(screen.getByText('Inferred criteria · best effort')).toBeVisible();
    expect(screen.getByText('Documented requirements')).toBeVisible();
    expect(screen.getByText('How long are operation keys retained?')).not.toBeVisible();
    fireEvent.click(screen.getAllByText('Source evidence')[1]);
    expect(screen.getByText('operationKey')).toBeVisible();
    expect(screen.queryByRole('button', { name: /confirm in review options/ })).not.toBeInTheDocument();
    expect(value.uniqueFindings).toHaveLength(1);
    expect(value.run).toBeUndefined();
  });

  it('keeps earlier context when reloading fails, exposes empty results, and cancels loading on close', async () => {
    const value = board();
    const loadContext = vi.fn()
      .mockRejectedValueOnce(new Error('Model unavailable'))
      .mockResolvedValueOnce({ ...value, contextDiscovery: {
        status: 'empty', generatedAt: 'now', summary: '', requirements: [], questions: ['Add acceptance criteria.'],
      } })
      .mockImplementationOnce(() => new Promise(() => {}));
    setup(value, true, {}, { loadContext });
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    fireEvent.click(screen.getByText('Acceptance criteria and source evidence'));
    fireEvent.click(screen.getByRole('button', { name: 'Load context with metasession' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Model unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Load context with metasession' }));
    expect(await screen.findByText('No source-backed criteria could be established. The review uses available code evidence and reports remaining limitations.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reload context with metasession' }));
    expect(screen.getByRole('button', { name: 'Loading with metasession…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(loadContext.mock.calls[2][0].aborted).toBe(true);
  });

  it('rejects context returned for another review and supports explicit cancellation', async () => {
    const loadContext = vi.fn().mockResolvedValueOnce({ ...board(), featureId: 'other' })
      .mockImplementationOnce(() => new Promise(() => {}));
    setup(board(), true, {}, { loadContext });
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    fireEvent.click(screen.getByText('Acceptance criteria and source evidence'));
    fireEvent.click(screen.getByRole('button', { name: 'Load context with metasession' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Review changed');
    fireEvent.click(screen.getByRole('button', { name: 'Load context with metasession' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel context loading' }));
    expect(loadContext.mock.calls[1][0].aborted).toBe(true);
    expect(screen.getByRole('button', { name: 'Load context with metasession' })).toBeEnabled();
  });
  it('does not fetch an unrelated skill inventory or invent attribution for legacy reviews', () => {
    const value = board();
    delete value.run;
    value.uniqueFindings = [];
    value.perspectives.forEach((perspective) => { perspective.findings = []; });
    const loadRepositorySkills = vi.fn(async () => ({
      repoId: value.repoId, repository: { name: 'Example/ReviewedRepo', remoteUrl: 'https://example.test/reviewed' },
      targetBranch: 'release/target', baseSha: 'target-revision', warnings: [],
      skills: [{ id: 'repository:policy@target-revision', name: 'Repository retry policy', source: 'policy.md@target-revision',
        fingerprint: 'version', content: '**Reuse the operation key.**', perspectiveIds: [] }],
    }));
    setup(value, true, {}, { loadRepositorySkills });
    openTool('Skills and related comments');
    expect(loadRepositorySkills).not.toHaveBeenCalled();
    expect(screen.queryByText('Repository retry policy')).not.toBeInTheDocument();
    expect(screen.getByText(/legacy review did not record skill attribution/)).toBeVisible();
    expect(screen.getByText(/Skill usage cannot be established/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Refresh repository skills' })).not.toBeInTheDocument();
  });

  it('keeps uncited captured skills and never attributes old findings to a newer available version', async () => {
    const value = board();
    value.run!.context.skills.push({ ...value.run!.context.skills[0], id: 'unused', name: 'Unused policy' });
    value.uniqueFindings![0].skillIds = [];
    value.uniqueFindings![0].observations[1].skillIds = ['billing'];
    const loadRepositorySkills = vi.fn(async () => ({
      repoId: value.repoId, repository: null, targetBranch: 'main', warnings: [],
      skills: [{ ...value.run!.context.skills[0], id: 'billing-v2', name: 'Updated billing policy', fingerprint: 'new-version' }],
    }));
    setup(value, true, {}, { loadRepositorySkills });
    openTool('Skills and related comments');
    expect(loadRepositorySkills).not.toHaveBeenCalled();
    expect(screen.queryByText('Updated billing policy')).not.toBeInTheDocument();
    expect(screen.getByText('Unused policy')).not.toBeVisible();
    expect(screen.getByText('Billing policy')).toBeVisible();
    fireEvent.click(screen.getByText('Other captured references (1)'));
    expect(screen.getByText('Unused policy')).toBeVisible();
    expect(screen.getByText('Captured as context only; no completed finding cites it.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: `high: ${finding.title}` })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: `high: ${finding.title}` }));
    expect(screen.getByRole('dialog', { name: finding.title })).toBeVisible();
  });

  it('keeps captured provenance independent of newer repository inventory availability', () => {
    const loadRepositorySkills = vi.fn().mockRejectedValueOnce(new Error('Access denied'))
      .mockResolvedValueOnce({ repoId: 'wrong-repository', skills: [], warnings: [] });
    setup(board(), true, {}, { loadRepositorySkills });
    openTool('Skills and related comments');
    expect(loadRepositorySkills).not.toHaveBeenCalled();
    expect(screen.getByText('Billing policy')).toBeVisible();
    expect(screen.queryByText(/No repository skills matched/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Skill instructions and version'));
    expect(screen.getByText('Do not double-charge.')).toBeVisible();
    expect(screen.getByText('skill-rev')).toBeVisible();
  });

  it('keeps uncited metadata honest and collapsed without loading live inventory', async () => {
    const value = board();
    value.run!.context.skills.push({ id: 'repository:policy', name: 'Metadata-only skill', source: 'skills/policy/SKILL.md@base',
      fingerprint: '', content: '', perspectiveIds: [], contentStatus: 'not-loaded' });
    const loadRepositorySkills = vi.fn(async (_signal: AbortSignal) => ({
      repoId: value.repoId, repository: null, targetBranch: 'main', warnings: ['Instruction budget reached'],
      skills: [{ id: 'repository:policy', name: 'Metadata-only skill', source: 'skills/policy/SKILL.md@base',
        fingerprint: '', content: '', perspectiveIds: [], contentStatus: 'not-loaded' as const }],
    }));
    setup(value, true, {}, { loadRepositorySkills });
    openTool('Skills and related comments');
    expect(screen.getByText('Metadata-only skill')).not.toBeVisible();
    fireEvent.click(screen.getByText('Other captured references (1)'));
    const metadata = screen.getByText('Metadata-only skill').closest('article')!;
    fireEvent.click(within(metadata).getByText('Skill instructions and version'));
    expect(screen.getByText(/Instructions were not loaded because of discovery limits/)).toBeVisible();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(loadRepositorySkills).not.toHaveBeenCalled();
  });
  it('uses clear context actions and safely renders structured Markdown instead of raw formatting', () => {
    const value = board();
    value.problem = '**Retry safety** is required.\n\n## Expected behavior\n\n- Keep `operationId` stable.\n- Return the original receipt.\n\n<script>alert(1)</script><a href="javascript:alert(1)">Unsafe link</a>';
    value.run!.context.businessRequirements = '- **One charge** per purchase.\n- Preserve the receipt.';
    const { onReviewDetails } = setup(value);
    expect(screen.getByText('Retry safety is required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Problem and solution' })).toHaveTextContent('Read explanation');
    expect(screen.getByRole('button', { name: 'Solution and changed code' })).toHaveTextContent('View changes');
    expect(screen.queryByText('ⓘ')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    const dialog = screen.getByRole('dialog', { name: 'Problem and solution' });
    fireEvent.click(within(dialog).getByText('Original review text'));
    expect(within(dialog).getByRole('heading', { name: 'Expected behavior' })).toBeVisible();
    expect(dialog.querySelectorAll('.rb-context-markdown li')).toHaveLength(2);
    expect(within(dialog).getByText('operationId').tagName).toBe('CODE');
    expect(within(dialog).queryByText('Business requirements captured for this review')).not.toBeInTheDocument();
    expect(dialog.querySelector('script')).toBeNull();
    expect(within(dialog).getByText('Unsafe link')).not.toHaveAttribute('href');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Inspect perspective assessments' }));
    expect(onReviewDetails).toHaveBeenCalledOnce();
  });

  it('formats changed-file lists and commit metadata while keeping raw evidence collapsed', () => {
    const value = board();
    const path = `src/${'nested/'.repeat(12)}charge.ts`;
    value.solution = `Protect retries.\n\n- \`${path}\` — reuse the operation key.\n- \`tests/charge.test.ts\` — cover duplicate requests.`;
    value.changedFiles = 2;
    value.pull.headSha = '83135e604092c40d7627a838834366e8e2382ab9';
    value.run!.context.evidence = 'Exact captured patch\n<script>not HTML</script>\n+ operationId';
    setup(value);
    fireEvent.click(screen.getByRole('button', { name: 'Solution and changed code' }));
    const dialog = screen.getByRole('dialog', { name: 'Solution and changed code' });
    expect(within(dialog).getByText(value.pull.headSha!)).not.toBeVisible();
    fireEvent.click(within(dialog).getByText('Captured code and revision'));
    expect(dialog.querySelectorAll('.rb-context-markdown li')).toHaveLength(2);
    expect(within(dialog).getByText(path).tagName).toBe('CODE');
    expect(within(dialog).getByText(value.pull.headSha!)).toBeVisible();
    expect(within(dialog).getByText('Changed files').nextElementSibling).toHaveTextContent('2');
    const evidence = dialog.querySelector('.rb-context-evidence')!;
    expect(evidence).not.toBeVisible();
    expect(evidence).toHaveTextContent('<script>not HTML</script>');
    expect(dialog.querySelector('script')).toBeNull();
    fireEvent.click(within(dialog).getByText('Original captured evidence'));
    expect(evidence).toBeVisible();
  });

  it('decodes captured code into readable file sections and never interprets code as HTML', () => {
    const value = board();
    value.run!.context.evidence = [
      JSON.stringify({ headSha: 'head' }),
      JSON.stringify({ path: 'src/charge.ts', whatChanged: 'Reuse the operation key before charging.',
        diff: '@@ -1 +1 @@\n-charge();\n+charge(operationKey);', source: '<script>not executable</script>' }),
      JSON.stringify({ path: 'src/empty.ts', whatChanged: 'No change summary was produced.', diff: '', source: '' }),
    ].join('\n');
    setup(value, false);
    fireEvent.click(screen.getByRole('button', { name: 'Solution and changed code' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'How the change addresses it' })).toBeVisible();
    fireEvent.click(within(dialog).getByText('Captured code and revision'));
    expect(within(dialog).getByText('Reuse the operation key before charging.')).toBeVisible();
    expect(dialog.querySelector('.rb-code-added')).toHaveTextContent('+charge(operationKey);');
    expect(dialog.querySelector('.rb-code-removed')).toHaveTextContent('-charge();');
    expect(dialog.querySelector('pre')).not.toHaveTextContent('"diff":');
    expect(dialog.querySelector('script')).toBeNull();
    expect(within(dialog).queryByText('No change summary was produced.')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByText('src/empty.ts'));
    expect(within(dialog).getByText(/This is an evidence gap/)).toBeVisible();
  });

  it('leads Explain with the concern and fix, keeping provenance and decisions out of the way until requested', async () => {
    setup();
    const explain = screen.getByRole('button', { name: `Why this comment? ${finding.title}` });
    expect(explain).toHaveTextContent(finding.title);
    fireEvent.click(explain);
    const dialog = screen.getByRole('dialog', { name: finding.title });
    expect(within(dialog).getByRole('heading', { name: 'Problem' })).toBeVisible();
    expect(within(dialog).getByRole('heading', { name: 'Fix' })).toBeVisible();
    expect(within(dialog).getByText('The write is not idempotent.')).toBeVisible();
    expect(within(dialog).getByText('Security actual model: not reported')).not.toBeVisible();
    expect(within(dialog).getByLabelText('Disposition reason')).not.toBeVisible();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review decision' }));
    await waitFor(() => expect(within(dialog).getByLabelText('Disposition reason')).toBeVisible());
    fireEvent.click(within(dialog).getByText('Review provenance'));
    expect(within(dialog).getByText('Security actual model: not reported')).toBeVisible();
  });

  it('keeps requirement traceability contextual, preserves source revisions, and links to original concerns', () => {
    const value = board();
    const requirement = { id: 'r1', text: 'Charge a purchase only once.', source: 'Reviewer-selected acceptance criteria',
      fingerprint: 'requirements-rev', priority: 1 };
    value.run!.context.requirements = [requirement];
    value.uniqueFindings![0].observations = [finding, { ...second, requirementIds: ['r1'] }];
    value.businessMatrix = [
      { requirement, assessment: 'violated', explanation: 'A retried write creates a second charge.',
        evidence: finding.evidence, findingIds: [second.id] },
      { requirement: { ...requirement, id: 'r2', text: 'Receipt retention policy is undecided.' },
        assessment: 'ambiguous', explanation: 'No retention period was supplied.', evidence: [], findingIds: [] },
    ];
    setup(value);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    fireEvent.click(screen.getByText('Acceptance criteria and source evidence'));
    const table = screen.getByRole('table', { name: 'Requirements and changed behavior in the captured review' });
    expect(within(table).getByText('violated')).toBeInTheDocument();
    expect(within(table).getByText('ambiguous')).toBeInTheDocument();
    expect(within(table).getAllByText(/requirements-rev/)).toHaveLength(2);
    expect(screen.getByText(/Suggested checks are not executed test results/)).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: `Inspect finding ${second.id}` }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: finding.title })).toBeInTheDocument();
    expect(screen.getByText('Charge a purchase only once.')).toBeInTheDocument();
    expect(screen.getByText('Reviewer-selected acceptance criteria · revision requirements-rev')).toBeInTheDocument();
  });

  it('filters by file and durable disposition without removing observations from review inputs', async () => {
    const value = board();
    const other = { ...second, id: 'business/two', title: 'Receipt is lost',
      evidence: [{ ...finding.evidence[0], source: 'src/receipt.ts',
        location: { path: 'src/receipt.ts', line: 8, side: 'RIGHT' as const } }] };
    value.uniqueFindings!.push({ id: 'group-two', finding: other, observations: [other], perspectiveIds: ['business'],
      skillIds: [], disposition: 'dismissed', dispositionReason: 'Receipt is stored on the parent record.' });
    setup(value);
    fireEvent.click(screen.getByRole('button', { name: 'Filter review comments' }));
    fireEvent.change(screen.getByLabelText('Filter file'), { target: { value: 'src/receipt.ts' } });
    fireEvent.change(screen.getByLabelText('Filter disposition'), { target: { value: 'ignored' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Receipt is lost' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: finding.title })).not.toBeInTheDocument();
    expect(value.uniqueFindings![0].observations).toHaveLength(2);
    expect(screen.getByText('Showing 1 of 2 unique comments.')).toBeInTheDocument();
  });

  it('requires explicit reasoned grouping and supports split, severity and reversible decision history', async () => {
    const value = board();
    const other = { ...second, id: 'business/two', title: 'A different retry observation' };
    value.uniqueFindings!.push({ id: 'group-two', finding: other, observations: [other], perspectiveIds: ['business'], skillIds: [] });
    value.possibleDuplicates = [{ groupIds: ['group-one', 'group-two'], reason: 'Potentially the same retry boundary; verify the correction.' }];
    value.findingHistory = [{ id: 'event-one', action: 'merge', observationIds: [finding.id, second.id], reason: 'Same changed write and correction.', at: '2026-01-01' }];
    const onManage = vi.fn().mockResolvedValue(undefined);
    setup(value, true, {}, { onManage });
    expect(screen.queryByText('Potentially the same retry boundary; verify the correction.')).not.toBeInTheDocument();
    openTool('Manage review comments and history');
    expect(screen.getByText(/These are candidates, not automatic merges/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select candidate groups 1' }));
    expect(onManage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Review decision'), { target: { value: 'merge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give a reason for this review decision.');
    fireEvent.change(screen.getByLabelText('Finding management reason'), { target: { value: 'Same changed write and correction.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(onManage).toHaveBeenLastCalledWith({
      expectedRunId: 'run', expectedAssessmentRevision: 3, action: 'merge',
      groupIds: ['group-one', 'group-two'], reason: 'Same changed write and correction.',
    }));
    await waitFor(() => expect(screen.getByLabelText('Finding management reason')).toHaveValue(''));
    fireEvent.click(screen.getByRole('checkbox', { name: /Retry duplicates the charge/ }));
    fireEvent.change(screen.getByLabelText('Finding management reason'), { target: { value: 'Distinct causes in the original evidence.' } });
    fireEvent.change(screen.getByLabelText('Review decision'), { target: { value: 'split' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(onManage).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'split', groupIds: ['group-one'] })));
    await waitFor(() => expect(screen.getByLabelText('Finding management reason')).toHaveValue(''));
    fireEvent.click(screen.getByRole('checkbox', { name: /Retry duplicates the charge/ }));
    fireEvent.change(screen.getByLabelText('Finding management reason'), { target: { value: 'Impact limited by the captured invariant.' } });
    fireEvent.change(screen.getByLabelText('Review decision'), { target: { value: 'severity' } });
    fireEvent.change(screen.getByLabelText('Severity override'), { target: { value: 'low' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save decision' }));
    await waitFor(() => expect(onManage).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'severity', severity: 'low' })));
    await waitFor(() => expect(screen.getByLabelText('Finding management reason')).toHaveValue(''));
    fireEvent.change(screen.getByLabelText('Finding management reason'), { target: { value: 'Restore the separate original observations.' } });
    fireEvent.click(screen.getByText('Decision history (1)'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo decision event-one' }));
    await waitFor(() => expect(onManage).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'undo', groupIds: [], targetEventId: 'event-one', reason: 'Restore the separate original observations.',
    })));
    expect(value.uniqueFindings![0].observations).toEqual([finding, second]);
  });

  it('records disposition against run revision, preserves failed drafts, and never mutates legacy state for a run', async () => {
    const value = board();
    value.uniqueFindings![0].disposition = 'dismissed';
    value.uniqueFindings![0].dispositionReason = 'The previous reviewer excluded this scenario.';
    const onManage = vi.fn().mockRejectedValueOnce(new Error('Assessment changed. Reload first.')).mockResolvedValue(undefined);
    const { onDisposition } = setup(value, true, {}, { onManage });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reopen comment' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give a reason for reopening.');
    fireEvent.change(screen.getByLabelText('Disposition reason'), { target: { value: 'Current evidence still supports the concern.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reopen comment' }));
    await screen.findByText('Assessment changed. Reload first.');
    expect(screen.getByLabelText('Disposition reason')).toHaveValue('Current evidence still supports the concern.');
    expect(onManage).toHaveBeenCalledWith({
      expectedRunId: 'run', expectedAssessmentRevision: 3, action: 'disposition', groupIds: ['group-one'],
      disposition: 'open', reason: 'Current evidence still supports the concern.',
    });
    expect(onDisposition).not.toHaveBeenCalled();
  });

  it('links resolved PR discussions without marking findings fixed or silently merging matches', () => {
    const thread = { id: 'thread', status: 'resolved' as const, url: 'https://example.test/discussion' };
    const refresh = vi.fn();
    const { onDisposition } = setup(board(), true, {}, {
      discussion: { matches: { 'group-one': [thread], [finding.id]: [thread] }, warnings: [] }, onRefreshDiscussion: refresh,
    });
    expect(screen.getByText('Already discussed ·')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'View discussion (resolved)' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Leave a comment' })).toBeEnabled();
    expect(screen.queryByText('Fix verified')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review disposition' }));
    expect(screen.getByText(/Thread resolution is not proof/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh live discussion' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(onDisposition).not.toHaveBeenCalled();
  });

  it('shows actionable unique comments from every perspective without expanding explanation or dashboards', async () => {
    const { onDiff } = setup();
    expect(screen.getByText('Retries must preserve one charge.')).toBeInTheDocument();
    expect(screen.getByText('Add a retry loop.')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: finding.title })).toHaveLength(1);
    expect(screen.getByText('A retry charges twice. Persist an operation key.')).toBeVisible();
    expect(screen.queryByText('The write is not idempotent.')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing policy')).not.toBeInTheDocument();
    expect(screen.queryByText('Security')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'src/charge.ts:12' }));
    expect(onDiff).toHaveBeenCalledWith(finding);
    const why = screen.getByRole('button', { name: `Why this comment? ${finding.title}` });
    why.focus();
    fireEvent.click(why);
    const dialog = screen.getByRole('dialog', { name: finding.title });
    expect(within(dialog).getByText('Security, Business')).toBeInTheDocument();
    expect(within(dialog).getByText('The write is not idempotent.')).toBeInTheDocument();
    expect(within(dialog).getByText('Original observations (2)')).toBeInTheDocument();
    expect(why).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(why).toHaveFocus();
  });

  it('navigates from a skill snapshot back to citing comments without attributing unverified compliance', () => {
    setup();
    openTool('Skills and related comments');
    expect(screen.getByText(/does not prove every instruction was followed/)).toBeInTheDocument();
    expect(screen.getByText('Do not double-charge.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `high: ${finding.title}` }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: finding.title })).toBeInTheDocument();
  });

  it('keeps publication independent and requires reasons or verification before disposition changes', () => {
    const { onDisposition, onPost } = setup(board(), true, { [finding.id]: 'posted' });
    expect(screen.getByText('Posted · still requires review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave a comment' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Review disposition' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss with reason' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Give a reason for dismissal.');
    expect(onDisposition).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Disposition reason'), { target: { value: 'Existing operation key protects this path.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss with reason' }));
    expect(onDisposition).toHaveBeenCalledWith([finding.id, second.id], 'ignored', 'Existing operation key protects this path.');
    fireEvent.click(screen.getByRole('button', { name: 'Verify fix' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Describe how the fix was verified.');
    fireEvent.change(screen.getByLabelText('Disposition reason'), { target: { value: 'Verified patched retry uses the same key.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify fix' }));
    expect(onDisposition).toHaveBeenLastCalledWith([finding.id, second.id], 'resolved', 'Verified patched retry uses the same key.');
    expect(onPost).not.toHaveBeenCalled();
  });

  it('filters presentation without dropping observations or treating an empty filtered list as clean', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Filter review comments' }));
    fireEvent.change(screen.getByLabelText('Filter severity'), { target: { value: 'low' } });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await screen.findByText('No comments match these filters.');
    expect(screen.queryByText(/No issues found/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('heading', { name: finding.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filter review comments' }));
    fireEvent.click(screen.getByLabelText('All observations (without grouping)'));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getAllByRole('heading', { name: finding.title })).toHaveLength(2);
  });

  it('never calls an incomplete or legacy empty review clean and exposes missing business requirements', async () => {
    const value = board();
    value.uniqueFindings = [];
    value.perspectives.forEach((p) => { p.findings = []; });
    delete value.run;
    const view = setup(value, false);
    expect(screen.getByRole('status')).toHaveTextContent('Review incomplete.');
    fireEvent.click(screen.getByRole('button', { name: 'Problem and solution' }));
    expect(screen.getByRole('heading', { name: 'Why this change is needed' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'How the change addresses it' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Business context' })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    view.rerender(<ReviewOverview board={value} complete running={false} resolutions={{}} publications={{}}
      onPost={vi.fn()} onDiff={vi.fn()} onDisposition={vi.fn()} onReviewDetails={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('No issues found in the completed review. This is not an approval.');
  });
});
