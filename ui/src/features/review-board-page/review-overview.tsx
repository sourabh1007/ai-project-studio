import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal } from '../../components/ui.js';
import { ChevronIcon } from '../../components/icons.js';
import { markdownPreviewText, renderMarkdownComment } from '../../lib/markdown.js';
import { annotateDiffLines, type DiffDisplayLine } from '../../lib/diff-lines.js';
import { parseFindingDetail } from '../../lib/finding-detail.js';
import { evidencePath, type FindingResolutionMap } from '../../lib/review-format.js';
import type { ReviewBoard, ReviewDiscussion, ReviewEvidence, ReviewFinding, ReviewFindingGroup, ReviewFindingMutation, ReviewRepositorySkills } from '../../lib/types.js';
import { ReviewBusinessDetails, ReviewContextLoader } from './review-business-details.js';
import { ReviewFindingManagement } from './review-finding-management.js';
import { ReviewInsights } from './review-insights.js';

const severityOrder = ['critical', 'high', 'medium', 'low', 'suggestion'];
type CapturedSkill = ReviewRepositorySkills['skills'][number];

function skillOrigin(skill: CapturedSkill): 'repository' | 'ide' | 'shared' {
  if (skill.source.startsWith('studio:') || skill.id.startsWith('studio:')) return 'ide';
  return skill.source.startsWith('shared:') || skill.id.startsWith('shared:') ? 'shared' : 'repository';
}

function summary(text: string): string {
  const paragraph = markdownPreviewText(text.trim().split(/\n\s*\n/)[0]!)
    .replace(/\b(?:[\w.-]+\/){2,}([\w.-]+\.\w+)\b/g, '$1');
  const concise = paragraph.split(/\s+/).slice(0, 35).join(' ');
  return concise.length > 180 ? `${concise.slice(0, 177).trimEnd()}…` : concise.length < paragraph.length ? `${concise}…` : concise;
}

function ReviewNarrative({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdownComment(text), [text]);
  return <div className="pr-comment-body rb-context-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function ReviewShortText({ text, diagrams = false, detailsLabel = 'Full explanation', previewText }: {
  text: string; diagrams?: boolean; detailsLabel?: string; previewText?: string;
}) {
  const diagram = diagrams ? text.match(/```(?:text|ascii)?[ \t]*\r?\n([\s\S]*?)```/) : null;
  const shortDiagram = diagram && diagram[1]!.trimEnd().split('\n').length <= 6 ? diagram[0] : null;
  const remaining = diagram ? text.replace(diagram[0], '').trim() : text.trim();
  const preview = summary(previewText ?? remaining);
  return <div className="rb-short-text">
    {preview && <p className="rb-two-line">{preview}</p>}
    {shortDiagram && <ReviewNarrative text={shortDiagram} />}
    {(remaining !== preview || (diagram && !shortDiagram)) && <details className="rb-context-disclosure">
      <summary>{detailsLabel}</summary>
      <ReviewNarrative text={text} />
    </details>}
  </div>;
}

function solutionText(board: ReviewBoard, running: boolean): string {
  if (running && (!board.solution || board.solution.startsWith('The review has not explained the solution yet.'))) {
    return 'Analysing how the changes address the problem. Available explanations appear here as checks finish.';
  }
  if (board.solution && board.problem &&
    markdownPreviewText(board.solution.split(/\n\s*\n/)[0]!).trim().toLowerCase() ===
    markdownPreviewText(board.problem.split(/\n\s*\n/)[0]!).trim().toLowerCase()) {
    return 'This review did not capture a distinct explanation of the implemented fix.';
  }
  return board.solution || 'Solution summary is not available for this review.';
}

type CapturedFile = { path: string; diff: string; source: string; whatChanged: string };

function capturedCodeFiles(evidence: string | undefined): CapturedFile[] {
  const files: CapturedFile[] = [];
  for (const line of (evidence ?? '').split(/\r?\n/)) {
    try {
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== 'object' || !('path' in entry) || typeof entry.path !== 'string') continue;
      const file = entry as Record<string, unknown>;
      files.push({ path: entry.path, diff: typeof file.diff === 'string' ? file.diff : '',
        source: typeof file.source === 'string' ? file.source : '',
        whatChanged: typeof file.whatChanged === 'string' && !/^No .*produced/i.test(file.whatChanged) ? file.whatChanged : '' });
    } catch { /* Older snapshots can contain plain text or metadata lines. */ }
  }
  return files;
}

function explanationCode(evidence: string | undefined, kind: 'problem' | 'solution', requested: string) {
  const [path, ...requestedLines] = requested.replace(/\r\n/g, '\n').split('\n');
  const files = capturedCodeFiles(evidence);
  const matching = files.filter((file) => file.path === path);
  const changedKind = kind === 'problem' ? 'del' : 'add';
  const chunks = (matching.length ? matching : files).flatMap((file) => {
    const hunks: DiffDisplayLine[][] = [];
    for (const line of annotateDiffLines(file.diff.replace(/\r\n/g, '\n'))) {
      if (line.kind === 'hunk') hunks.push([]);
      else if (hunks.length && (line.kind === 'ctx' || line.kind === changedKind) && !line.raw.startsWith('\\')) {
        hunks.at(-1)!.push(line);
      }
    }
    return hunks.filter((lines) => lines.length).map((lines) => ({ path: file.path, lines,
      code: lines.map((line) => /^[ +\-]/.test(line.raw) ? line.raw.slice(1) : line.raw).join('\n') }));
  });
  const wanted = requestedLines.join('\n');
  const exact = wanted && requestedLines.length <= 12
    ? chunks.find((chunk) => chunk.path === path && `\n${chunk.code}\n`.includes(`\n${wanted}\n`)) : undefined;
  if (exact) return { path: exact.path, code: wanted };
  const chunk = chunks.find((entry) => entry.lines.some((line) => line.kind === changedKind)) ?? chunks[0];
  if (!chunk) return null;
  const start = Math.max(0, chunk.lines.findIndex((line) => line.kind === changedKind) - 2);
  return { path: chunk.path, code: chunk.code.split('\n').slice(start, start + 12).join('\n') };
}

function ReviewWalkthrough({ board, kind, text, running }: {
  board: ReviewBoard; kind: 'problem' | 'solution'; text: string; running: boolean;
}) {
  const analysis = board.analyses?.['problem-solution'];
  const points = analysis?.skipped ? [] : analysis?.rationale ?? [];
  const point = (label: string) => points.find((entry) => entry.label.trim().toLowerCase() === `${kind} ${label}`)?.detail.trim() ?? '';
  const recordedExample = point('example');
  const example = markdownPreviewText(recordedExample) === markdownPreviewText(text.split(/\n\s*\n/)[0]!) ? '' : recordedExample;
  const requestedCode = point('code');
  const code = useMemo(() => explanationCode(board.run?.context.evidence, kind, requestedCode),
    [board.run?.context.evidence, kind, requestedCode]);
  const original = text.replace(/```(?:text|ascii)?[ \t]*\r?\n[\s\S]*?```/g, '').trim();
  return <div className="rb-walkthrough">
    <h4>Example</h4>
    {example ? <ReviewNarrative text={example} />
      : <p className="rb-context-note">{running ? 'The scenario example is still being analysed.' : 'No scenario example was recorded for this saved review.'}</p>}
    <h4>{kind === 'problem' ? 'Before the change' : 'After the change'}</h4>
    {code ? <><p className="rb-context-note"><code>{code.path}</code> · captured excerpt</p>
      <pre className="rb-context-evidence"><code>{code.code}</code></pre></>
      : <p className="rb-context-note">No {kind === 'problem' ? 'before' : 'after'}-change code excerpt was captured.</p>}
    {summary(original) !== markdownPreviewText(original) && <details className="rb-context-disclosure">
      <summary>Original review text</summary><ReviewNarrative text={original} />
    </details>}
  </div>;
}

function ReviewExplanation({ board, kind, running, expanded = false }: {
  board: ReviewBoard; kind: 'problem' | 'solution'; running: boolean; expanded?: boolean;
}) {
  const text = kind === 'problem' ? board.problem || 'The problem has not been explained yet.' : solutionText(board, running);
  const diagram = text.match(/```(?:text|ascii)?[ \t]*\r?\n([\s\S]*?)```/);
  const narrative = diagram ? text.replace(diagram[0], '').trim() : text;
  return <div className="rb-short-text">
    <p className="rb-two-line">{summary(narrative)}</p>
    {expanded && diagram && <ReviewNarrative text={diagram[0]} />}
    {expanded && <ReviewWalkthrough board={board} kind={kind} text={text} running={running} />}
  </div>;
}

function ReviewChangeExplanation({ board, running }: { board: ReviewBoard; running: boolean }) {
  return <div className="rb-change-explanation">
    <h3>Why this change is needed</h3>
    <ReviewExplanation board={board} kind="problem" running={running} expanded />
    <h3>How the change addresses it</h3>
    <ReviewExplanation board={board} kind="solution" running={running} expanded />
  </div>;
}

function ReviewSkillsDetails({ board, groups, onFinding }: {
  board: ReviewBoard;
  groups: ReviewFindingGroup[];
  onFinding: (group: ReviewFindingGroup) => void;
}) {
  const captured = board.run?.context.skills ?? [];
  const citedGroups = (id: string) => groups.filter((group) => group.skillIds.includes(id) ||
    [group.finding, ...group.observations].some((finding) => finding.skillIds?.includes(id)));
  const cited = captured.filter((skill) => !skill.contentStatus && skill.content.trim() && citedGroups(skill.id).length > 0);
  const supplied = captured.filter((skill) => !cited.includes(skill));
  const card = (skill: ReviewRepositorySkills['skills'][number]) => {
    const cited = citedGroups(skill.id);
    return <article className="rb-context-section" key={skill.id}>
      <h3>{skill.name}</h3>
      <p className="rb-context-note"><code>{skill.source}</code></p>
      <p>{skill.contentStatus ? 'Referenced; instructions unavailable.' : `Captured for ${skill.perspectiveIds.length || board.run?.perspectiveIds.length || 0} checks.`}</p>
      {cited.length ? <ul className="rb-context-links">{cited.map((group) => <li key={group.id}>
        <button type="button" className="rb-linkish" onClick={() => onFinding(group)}>
          {group.finding.severity}: {group.finding.title}
        </button>
      </li>)}</ul> : <p className="rb-context-note">Captured as context only; no completed finding cites it.</p>}
      <details className="rb-skill-snapshot">
        <summary>Skill instructions and version</summary>
        {skill.contentStatus ? <p className="rb-context-note">{skill.contentStatus === 'not-loaded'
          ? 'Instructions were not loaded because of discovery limits. The tracked file is still listed at its pinned revision.'
          : 'Instructions could not be loaded. See discovery notes; the tracked file is still listed.'}</p> : <>
          <p className="rb-context-note">Content fingerprint: <code>{skill.fingerprint}</code></p>
          <ReviewNarrative text={skill.content} />
        </>}
      </details>
    </article>;
  };
  return <div className="rb-context-content" role="region" aria-label="Repository skills and review findings" tabIndex={0}>
    <p>Captured guidance only. A citation does not prove every instruction was followed or tools ran.</p>
    {!board.run && <p className="rb-context-empty">This legacy review did not record skill attribution. Start a new review to capture it.</p>}
    <section><h3>Skills cited by review comments ({cited.length})</h3>
      {cited.length === 0 && <p className="rb-context-note">No completed review comments cite a captured skill. Skill usage cannot be established from this run.</p>}
    </section>
    {(['repository', 'ide', 'shared'] as const).map((origin) => {
      const belongs = (skill: CapturedSkill) => skillOrigin(skill) === origin;
      const other = supplied.filter(belongs);
      if (!captured.some(belongs)) return null;
      return <section key={origin}>
        <h3>{origin === 'ide' ? 'IDE-level skills' : origin === 'shared' ? 'Shared context' : 'Repository skills'} ({captured.filter(belongs).length})</h3>
        <div className="rb-skill-list">{cited.filter(belongs).map(card)}</div>
        {other.length > 0 && <details className="rb-context-disclosure">
          <summary>Other captured references ({other.length})</summary>
          <p>Not counted as cited guidance; usage is not established.</p>
          <div className="rb-skill-list">{other.map(card)}</div>
        </details>}
      </section>;
    })}
  </div>;
}

function CapturedCodeEvidence({ evidence }: { evidence?: string }) {
  const files = capturedCodeFiles(evidence);
  if (!files.length) return <section className="rb-context-section">
    <h3>Code changes</h3><p>No structured code evidence was recorded for this saved review.</p>
    {evidence && <details><summary>Original captured evidence</summary><pre className="rb-context-evidence">{evidence}</pre></details>}
  </section>;
  return <section aria-label="Captured file changes"><h3>Code changes behind the solution</h3>
    <p className="rb-context-note">Exact captured changes, not executed tests. Added lines start with +; removed lines start with −. Expand a file to inspect its code.</p>
    {files.map((file, index) => <details className="rb-context-disclosure rb-code-file" key={`${file.path}:${index}`} open={index === 0}>
      <summary>{file.path}</summary>
      {file.whatChanged && <ReviewNarrative text={file.whatChanged} />}
      {file.diff || file.source ? <pre className="rb-context-evidence">{(file.diff || file.source).split('\n').map((line, index) =>
        <span key={index} className={line.startsWith('+') ? 'rb-code-added' : line.startsWith('-') ? 'rb-code-removed' : ''}>{line}{'\n'}</span>)}</pre>
        : <p>Code content was not captured for this file. This is an evidence gap, not a completed inspection.</p>}
    </details>)}
  </section>;
}

export function ReviewOverview({ board, complete, running, resolutions, publications, resolutionReasons = {}, discussion,
  onPost, onDiff, onDisposition, onReviewDetails, onManage, onRefreshDiscussion, onEvidence,
  loadContext }: {
  board: ReviewBoard;
  complete: boolean;
  running: boolean;
  resolutions: FindingResolutionMap;
  publications: Record<string, 'pending' | 'posted' | 'uncertain'>;
  resolutionReasons?: Record<string, string>;
  discussion?: ReviewDiscussion;
  onPost: (finding: ReviewFinding, groupId?: string) => void;
  onDiff: (finding: ReviewFinding) => void;
  onDisposition: (ids: string[], disposition: 'resolved' | 'ignored' | null, reason?: string) => void;
  onReviewDetails: () => void;
  onManage?: (input: ReviewFindingMutation) => Promise<void>;
  onRefreshDiscussion?: () => void;
  onEvidence?: (evidence: ReviewEvidence) => void;
  loadRepositorySkills?: (signal: AbortSignal) => Promise<ReviewRepositorySkills>;
  loadContext?: (signal: AbortSignal) => Promise<ReviewBoard>;
}) {
  const [detail, setDetail] = useState<'problem' | 'solution' | 'finding' | 'skills' | 'filters' | 'management' | null>(null);
  const [findingId, setFindingId] = useState<string | null>(null);
  const [perspective, setPerspective] = useState('');
  const [skill, setSkill] = useState('');
  const [severity, setSeverity] = useState('');
  const [disposition, setDisposition] = useState('');
  const [file, setFile] = useState('');
  const [requirement, setRequirement] = useState('');
  const [observations, setObservations] = useState(false);
  const [reason, setReason] = useState('');
  const [dispositionError, setDispositionError] = useState('');
  const [dispositionBusy, setDispositionBusy] = useState(false);
  const [dispositionOpen, setDispositionOpen] = useState(false);
  const dispositionRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    setDetail(null);
    setFindingId(null);
    setReason('');
    setPerspective('');
    setSkill('');
    setSeverity('');
    setDisposition('');
    setFile('');
    setRequirement('');
    setObservations(false);
    setDispositionOpen(false);
  }, [board.featureId, board.run?.id]);
  const groups = useMemo<ReviewFindingGroup[]>(() => {
    if (board.uniqueFindings && !observations) return board.uniqueFindings;
    return board.perspectives.flatMap((p) => p.findings.map((finding) => ({
      id: `${p.id}/${finding.id}`, finding, observations: [finding],
      perspectiveIds: [p.id], skillIds: finding.skillIds ?? [],
    })));
  }, [board.uniqueFindings, board.perspectives, observations]);
  const canonicalGroup = (group: ReviewFindingGroup) => board.uniqueFindings?.find((candidate) =>
    candidate.id === group.id || candidate.observations.some((observation) =>
      group.observations.some((entry) => entry.id === observation.id))) ?? group;
  const resolution = (group: ReviewFindingGroup) => {
    const saved = canonicalGroup(group).disposition;
    if (saved) return saved === 'fix-verified' ? 'resolved' : saved === 'dismissed' ? 'ignored' : null;
    if (board.run && onManage) return null;
    const ids = group.observations.length ? group.observations.map((f) => f.id) : [group.finding.id];
    return ids.every((id) => resolutions[id]) ? resolutions[ids[0]] : null;
  };
  const findingPaths = (group: ReviewFindingGroup) => [...new Set([group.finding, ...group.observations]
    .flatMap((finding) => finding.evidence.map((entry) => entry.location?.path ?? evidencePath(entry.source)).filter((path): path is string => Boolean(path))))];
  const files = [...new Set(groups.flatMap(findingPaths))].sort();
  const discussed = (group: ReviewFindingGroup) => {
    const threads = [canonicalGroup(group).id, group.id, group.finding.id, ...group.observations.map((observation) => observation.id)]
      .flatMap((id) => discussion?.matches[id] ?? []);
    return [...new Map(threads.map((thread) => [thread.id, thread])).values()];
  };
  const visible = groups.filter((group) =>
    [group.finding, ...group.observations].some((finding) =>
      (!perspective || finding.perspectiveId === perspective) &&
      (!skill || finding.skillIds?.includes(skill)) &&
      (!requirement || finding.requirementIds?.includes(requirement) ||
        board.businessMatrix?.find((row) => row.requirement.id === requirement)?.findingIds.includes(finding.id)) &&
      (!file || (file === '__unlocated' ? findingPaths({ ...group, finding, observations: [] }).length === 0
        : findingPaths({ ...group, finding, observations: [] }).includes(file)))) &&
    (!severity || group.finding.severity === severity) &&
    (!disposition || (resolution(group) ?? 'open') === disposition))
    .sort((a, b) => severityOrder.indexOf(a.finding.severity) - severityOrder.indexOf(b.finding.severity));
  const selected = groups.find((group) => group.id === findingId);
  const selectedRequirementIds = [...new Set([...(selected?.finding.requirementIds ?? []),
    ...(selected?.observations.flatMap((observation) => observation.requirementIds ?? []) ?? [])])];
  const context = board.run?.context;
  const skills = context?.skills ?? [];
  const perspectiveNames = (ids: string[]) => ids.map((id) => board.perspectives.find((p) => p.id === id)?.name ?? id).join(', ');
  const detailButton = (label: string, target: NonNullable<typeof detail>, caption: string) => <button
    type="button" className="rb-detail-control" aria-label={label}
    aria-haspopup="dialog" aria-expanded={detail === target} onClick={(event) => {
      const tools = event.currentTarget.closest('details');
      if (tools) {
        tools.open = false;
        tools.querySelector('summary')?.focus();
      }
      setDetail(target);
    }} title={label}>
    {caption}<ChevronIcon size={12} />
  </button>;
  const openFinding = (group: ReviewFindingGroup, manage = false) => {
    setFindingId(group.id);
    setReason('');
    setDispositionError('');
    setDispositionOpen(manage);
    setDetail('finding');
  };
  const changeDisposition = async (value: 'resolved' | 'ignored' | null) => {
    if (!selected) return;
    if ((value || (board.run && onManage)) && !reason.trim()) {
      setDispositionError(value === 'ignored' ? 'Give a reason for dismissal.' : value === 'resolved' ? 'Describe how the fix was verified.' : 'Give a reason for reopening.');
      return;
    }
    setDispositionBusy(true);
    setDispositionError('');
    try {
      if (board.run && onManage) {
        await onManage({
          expectedRunId: board.run.id, expectedAssessmentRevision: board.run.revision,
          action: 'disposition', groupIds: [canonicalGroup(selected).id], reason: reason.trim(),
          disposition: value === 'resolved' ? 'fix-verified' : value === 'ignored' ? 'dismissed' : 'open',
        });
      } else {
        onDisposition([...new Set([selected.finding.id, ...selected.observations.map((f) => f.id)])], value, reason.trim());
      }
      setReason('');
    } catch (cause) {
      setDispositionError(cause instanceof Error ? cause.message : 'Could not save this finding decision.');
    } finally { setDispositionBusy(false); }
  };
  const inspectFindingId = (id: string) => {
    const group = groups.find((candidate) => candidate.id === id || candidate.finding.id === id || candidate.observations.some((finding) => finding.id === id));
    if (group) openFinding(group);
    else setDispositionError('That finding is unavailable in this review snapshot.');
  };
  return <section className="rb-overview" aria-label="Review overview">
    <div className="rb-overview-summary">
    <section className="rb-overview-section">
      <h3>Problem {detailButton('Problem and solution', 'problem', 'Read explanation')}</h3>
      <ReviewExplanation board={board} kind="problem" running={running} />
    </section>
    <section className="rb-overview-section">
      <h3>Solution {detailButton('Solution and changed code', 'solution', 'View changes')}</h3>
      <ReviewExplanation board={board} kind="solution" running={running} />
    </section>
    </div>
    <section className="rb-overview-section">
      <div className="rb-comments-heading"><h3>Review comments <span className="rb-comment-count">{groups.length}</span></h3>
        {detailButton('Filter review comments', 'filters', 'Filters')}
        <details className="rb-header-menu">
          <summary className="rb-detail-control">More tools</summary>
          <div className="rb-header-menu-items">
            {detailButton('Skills and related comments', 'skills', 'Review skills')}
            {detailButton('Manage review comments and history', 'management', 'Decisions')}
          </div>
        </details>
      </div>
      {!complete && !running && groups.length > 0 && <p className="rb-comments-note">Saved findings remain available, but this incomplete review does not certify the PR.</p>}
      {discussion?.warnings.length ? <p className="rb-essential-warning" role="note">Discussion access incomplete: {discussion.warnings[0]}</p> : null}
      {(perspective || skill || severity || disposition || file || requirement || observations) && <p className="rb-filter-notice">
        Showing {visible.length} of {groups.length} {observations ? 'observations' : 'unique comments'}.
        <button type="button" className="rb-linkish" onClick={() => {
          setPerspective(''); setSkill(''); setSeverity(''); setDisposition(''); setFile(''); setRequirement(''); setObservations(false);
        }}>Clear filters</button>
      </p>}
      {visible.length === 0 && <p role="status">{groups.length > 0
        ? 'No comments match these filters.'
        : running ? 'Review in progress. Comments will appear as perspectives finish.'
          : complete ? 'No issues found in the completed review. This is not an approval.'
            : 'Review incomplete. No comments yet; this is not a clean result.'}</p>}
      <ul className="rb-findings rb-unique-findings">
        {visible.map((group) => {
          const f = group.finding;
          const status = resolution(group);
          const location = f.evidence.find((e) => e.location)?.location;
          const path = location?.path ?? f.evidence.map((e) => evidencePath(e.source)).find(Boolean);
          const publication = publications[f.id] ?? group.observations.map((o) => publications[o.id]).find(Boolean);
          const threads = discussed(group);
          return <li key={group.id} className={`rb-finding rb-sev-${f.severity}${status ? ` is-${status}` : ''}`}>
            <div className="rb-finding-head">
              <span className={`rb-sev-tag rb-sev-tag-${f.severity}`}>{f.severity}</span>
              <h4 className="rb-finding-title" aria-label={f.title}><button type="button" className="rb-finding-open" aria-label={`Why this comment? ${f.title}`}
                title="Why this comment?" aria-haspopup="dialog" aria-expanded={detail === 'finding' && findingId === group.id}
                onClick={() => openFinding(group)}>{f.title}</button></h4>
            </div>
            {path && <button type="button" className="rb-evidence-link rb-location" onClick={() => onDiff(f)}>
              {path}{location ? `:${location.line}` : ''}
            </button>}
            <p className="rb-two-line">{summary(parseFindingDetail(f.detail)
                .filter((entry) => !entry.label || ['Problem', 'Fix/verify', 'Fix', 'Recommendation'].includes(entry.label))
                .map((entry) => entry.body).join(' ') || f.detail)}</p>
            <div className="rb-finding-actions">
              {threads.length > 0 && <span className="rb-discussion-badge">Already discussed · {threads.map((thread, index) => <span key={thread.id}>
                {index > 0 ? ', ' : ''}<a href={thread.url} target="_blank" rel="noreferrer">View discussion ({thread.status})</a>
              </span>)}</span>}
              {publication && <span role={publication === 'uncertain' ? 'alert' : undefined}>
                {publication === 'posted' ? 'Posted · still requires review' : publication === 'pending' ? 'Publication pending — check status' : 'Publication uncertain — check the PR before retrying'}
              </span>}
              {status ? <><span>{status === 'resolved' ? 'Fix verified' : 'Dismissed'}</span>
                <Button variant="ghost" onClick={() => board.run && onManage ? openFinding(group, true) : onDisposition([...new Set([f.id, ...group.observations.map((o) => o.id)])], null)}>Reopen</Button></>
                : <><Button variant="ghost" disabled={running || publication === 'posted'} onClick={() => onPost(f, canonicalGroup(group).id)}>
                  {publication === 'uncertain' || publication === 'pending' ? 'Check publication' : 'Leave a comment'}</Button>
                  <Button variant="ghost" onClick={() => openFinding(group, true)}>Review disposition</Button></>}
            </div>
          </li>;
        })}
      </ul>
    </section>
    {detail && <Modal title={detail === 'finding' ? selected?.finding.title ?? 'Comment details'
      : detail === 'problem' ? 'Problem and solution'
        : detail === 'solution' ? 'Solution and changed code'
          : detail === 'skills' ? 'Skills and related comments' : detail === 'management' ? 'Manage review comments and history' : 'Filter review comments'}
      size="lg" className={`rb-context-dialog${detail === 'problem' || detail === 'solution' || detail === 'finding' || detail === 'skills' ? ' rb-narrative-dialog' : ''}`} onClose={() => setDetail(null)}>
      {detail === 'problem' && <>
        <div className="rb-context-content" role="region" aria-label="Problem and solution explanation" tabIndex={0}>
          <ReviewChangeExplanation board={board} running={running} />
          <details className="rb-context-disclosure"><summary>Acceptance criteria and source evidence</summary>
          <ReviewContextLoader board={board} running={running} loadContext={loadContext} />
          <ReviewBusinessDetails board={board} onFinding={inspectFindingId} onEvidence={(entry) => {
            setDetail(null);
            if (onEvidence) onEvidence(entry);
            else onReviewDetails();
          }} />
          </details>
        </div>
        <div className="rb-context-actions">
          <Button variant="secondary" onClick={() => { setDetail(null); onReviewDetails(); }}>Inspect perspective assessments</Button>
        </div>
      </>}
      {detail === 'solution' && <>
        <div className="rb-context-content" role="region" aria-label="Solution and code details" tabIndex={0}>
          <ReviewChangeExplanation board={board} running={running} />
          <details className="rb-context-disclosure"><summary>Captured code and revision</summary>
          <dl className="rb-context-meta">
            <div><dt>Changed files</dt><dd>{board.changedFiles}</dd></div>
            <div><dt>Reviewed commit</dt><dd><code>{board.pull.headSha || 'unknown'}</code></dd></div>
          </dl>
          <CapturedCodeEvidence evidence={context?.evidence} />
          </details>
        </div>
        <div className="rb-context-actions">
          <Button variant="secondary" onClick={() => { setDetail(null); onReviewDetails(); }}>Inspect code, diffs and perspectives</Button>
        </div>
      </>}
      {detail === 'filters' && <div className="rb-options">
        <ReviewInsights key={board.run?.id ?? board.featureId} board={board} onFilter={(filter) => {
          setFile(filter.file ?? ''); setPerspective(filter.perspective ?? '');
          setRequirement(filter.requirement ?? '');
          setSkill(filter.skill ?? ''); setObservations(false); setSeverity(''); setDisposition('');
          setDetail(null);
        }} />
        <label>Perspective<select aria-label="Filter perspective" value={perspective} onChange={(e) => setPerspective(e.target.value)}>
          <option value="">All perspectives</option>{board.perspectives.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select></label>
        <label>Skill<select aria-label="Filter skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
          <option value="">All skills</option>{skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select></label>
        <label>Severity<select aria-label="Filter severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
          <option value="">All severities</option>{severityOrder.map((s) => <option key={s}>{s}</option>)}
        </select></label>
        <label>Requirement<select aria-label="Filter requirement" value={requirement} onChange={(event) => setRequirement(event.target.value)}>
          <option value="">All requirements</option>{board.businessMatrix?.map((row) => <option key={row.requirement.id} value={row.requirement.id}>{row.requirement.text}</option>)}
        </select></label>
        <label>File<select aria-label="Filter file" value={file} onChange={(event) => setFile(event.target.value)}>
          <option value="">All files</option><option value="__unlocated">Unlocated</option>{files.map((path) => <option key={path}>{path}</option>)}
        </select></label>
        <label>Disposition<select aria-label="Filter disposition" value={disposition} onChange={(e) => setDisposition(e.target.value)}>
          <option value="">All dispositions</option><option value="open">Open</option><option value="ignored">Dismissed</option><option value="resolved">Fix verified</option>
        </select></label>
        <label><input type="checkbox" checked={observations} onChange={(e) => setObservations(e.target.checked)} />All observations (without grouping)</label>
        <Button onClick={() => { setDetail(null); onReviewDetails(); }}>Perspective progress and sign-off</Button>
      </div>}
      {detail === 'management' && <ReviewFindingManagement board={board} running={running} onManage={onManage} onInspect={openFinding} />}
      {detail === 'skills' && <>
        {board.run && <div className="rb-guidance-tags" aria-label="Review skill provenance">
          {(['repository', 'ide', 'shared'] as const).map((origin) => {
            const captured = board.run!.context.skills.filter((skill) => !skill.contentStatus && skill.content.trim() &&
              skillOrigin(skill) === origin);
            if (origin === 'shared' && captured.length === 0) return null;
            const cited = captured.filter((skill) => groups.some((group) => group.skillIds.includes(skill.id) ||
              [group.finding, ...group.observations].some((finding) => finding.skillIds?.includes(skill.id)))).length;
            return <span key={origin} title="Captured prompt guidance; citations do not prove tool execution.">
              {origin === 'ide' ? 'IDE skills' : origin === 'shared' ? 'Shared context' : 'Repo skills'}: {captured.length} captured · {cited} cited
            </span>;
          })}
        </div>}
        <ReviewSkillsDetails board={board} groups={groups} onFinding={openFinding} />
      </>}
      {detail === 'finding' && selected && <>
        <div className="rb-context-content" role="region" aria-label="Finding explanation" tabIndex={0}>
          <div className="rb-context-kicker">
            <span className={`rb-sev-tag rb-sev-tag-${selected.finding.severity}`}>{selected.finding.severity}</span>
            <span>{perspectiveNames(selected.perspectiveIds)}</span>
          </div>
          {parseFindingDetail(selected.finding.detail).map((s, i) => <section className="rb-context-section" key={i}>
            <h3>{s.label || 'Concern'}</h3><ReviewNarrative text={s.body} />
          </section>)}
          <section className="rb-context-section">
            <h3>Code evidence</h3>
            {selected.finding.evidence.length ? <ul className="rb-context-links">{selected.finding.evidence.map((e, i) => <li key={i}>
              <button type="button" className="rb-linkish" onClick={() => { setDetail(null); onDiff(selected.finding); }}>{e.source}</button>
              <p>{e.reason}</p>
            </li>)}</ul> : <p className="rb-context-empty">No code evidence recorded for this finding.</p>}
          </section>
          <details className="rb-context-disclosure" open={discussed(selected).length > 0 || Boolean(discussion?.warnings.length)}>
            <summary>Live PR discussion</summary>
            <p className="rb-context-note">Thread resolution is not proof that this code fixes the concern. Refreshing discussion does not change the frozen review context.</p>
            {discussed(selected).map((thread) => <p key={thread.id}><a href={thread.url} target="_blank" rel="noreferrer">
              Already discussed — {thread.status}</a></p>)}
            {!discussed(selected).length && <p>{discussion?.warnings.length ? 'Thread matching is incomplete.' : 'No exact thread match reported.'}</p>}
            {discussion?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
            {onRefreshDiscussion && <Button variant="secondary" onClick={onRefreshDiscussion}>Refresh live discussion</Button>}
          </details>
          <details className="rb-context-disclosure">
            <summary>Requirements and skills</summary>
            <h4>Requirements cited by this finding</h4>
            {selectedRequirementIds.length ? selectedRequirementIds.map((id) => {
              const requirement = context?.requirements?.find((entry) => entry.id === id);
              return <section key={id}><p>{requirement?.text ?? `Unavailable requirement ${id}`}</p>
                {requirement && <p className="rb-context-note">{requirement.source} · revision {requirement.fingerprint}</p>}</section>;
            }) : <p>No requirement citations recorded for this finding.</p>}
            <h4>Skills cited by this finding</h4>
            {selected.skillIds.length === 0 ? <p>No skill citations recorded for this comment.</p> : selected.skillIds.map((id) => {
              const s = skills.find((entry) => entry.id === id);
              return <div key={id}><button type="button" className="rb-linkish" onClick={() => setDetail('skills')}>{s?.name ?? id}</button>
                <p className="rb-context-note">{s?.source ?? 'Snapshot unavailable'}</p></div>;
            })}
          </details>
          <details className="rb-context-disclosure">
            <summary>Review provenance</summary>
            <p><strong>Recorded model:</strong> {board.run ? `${board.run.providerId} / ${board.run.model}` : 'Unavailable on legacy review'}</p>
            {selected.perspectiveIds.map((id) => <p key={id}>{perspectiveNames([id])} actual model: {board.analyses?.[id]?.resolvedModel ?? 'not reported'}</p>)}
            <h4>Original observations ({selected.observations.length})</h4>
            {selected.observations.map((f) => <article className="rb-original-observation" key={`${f.perspectiveId}/${f.id}`}>
              <h4>{perspectiveNames([f.perspectiveId])}: {f.title}</h4><p className="rb-context-note">Original severity: {f.severity}</p>
              <ReviewNarrative text={f.detail} />
            </article>)}
          </details>
          <details className="rb-context-disclosure" ref={dispositionRef} open={dispositionOpen}
            onToggle={(event) => setDispositionOpen(event.currentTarget.open)}>
            <summary>{board.run && onManage ? 'Recorded disposition' : 'Local disposition'}</summary>
            <p className="rb-context-note">Posting a comment does not dismiss it or verify a code fix.</p>
            {(canonicalGroup(selected).dispositionReason || resolutionReasons[selected.finding.id]) &&
              <p>Recorded reason: {canonicalGroup(selected).dispositionReason ?? resolutionReasons[selected.finding.id]}</p>}
            <label>Reason or verification evidence<textarea aria-label="Disposition reason" value={reason} rows={3}
              onChange={(event) => setReason(event.target.value)} /></label>
            {dispositionError && <p role="alert">{dispositionError}</p>}
            <div className="rb-finding-actions">
              <Button disabled={dispositionBusy || running} onClick={() => void changeDisposition('ignored')}>Dismiss with reason</Button>
              <Button disabled={dispositionBusy || running} onClick={() => void changeDisposition('resolved')}>Verify fix</Button>
              <Button disabled={dispositionBusy || running} onClick={() => void changeDisposition(null)}>Reopen comment</Button>
            </div>
          </details>
        </div>
        <div className="rb-context-actions">
          <Button variant="secondary" onClick={() => {
            setDispositionOpen(true);
            requestAnimationFrame(() => dispositionRef.current?.querySelector('textarea')?.focus());
          }}>Review decision</Button>
        </div>
      </>}
    </Modal>}
  </section>;
}
