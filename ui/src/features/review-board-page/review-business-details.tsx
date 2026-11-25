import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui.js';
import type { ReviewBoard, ReviewContextDiscovery, ReviewEvidence } from '../../lib/types.js';

export function ReviewContextLoader({ board, running, loadContext }: {
  board: ReviewBoard;
  running: boolean;
  loadContext?: (signal: AbortSignal) => Promise<ReviewBoard>;
}) {
  const [loaded, setLoaded] = useState<ReviewContextDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setLoaded(null);
    setError('');
    setBusy(false);
    return () => { request.current?.abort(); };
  }, [board.featureId, board.pull.headSha, board.reviewUpdatedAt, board.run?.id]);
  const discovery = loaded ?? board.contextDiscovery;
  if (!loadContext && !discovery) return null;
  return <section className="rb-context-section rb-context-loader" aria-label="Metasession business context">
    <h3>Business context</h3>
    <p className="rb-context-note">Criteria are derived automatically from available MCP, PR and repository evidence. Inferred criteria are best-effort expectations, not documented business policy.</p>
    {loadContext && <div className="rb-context-actions">
      <Button disabled={busy || running} onClick={() => {
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setError('');
        void loadContext(controller.signal).then((result) => {
          if (controller.signal.aborted) return;
          if (result.featureId !== board.featureId || result.pull.headSha !== board.pull.headSha ||
              result.reviewUpdatedAt !== board.reviewUpdatedAt) {
            throw new Error('Review changed while loading context. Reopen this view and retry.');
          }
          setLoaded(result.contextDiscovery ?? null);
        }).catch((cause) => {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load business context.');
        }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
      }}>{busy ? 'Loading with metasession…' : discovery ? 'Reload context with metasession' : 'Load context with metasession'}</Button>
      {busy && <Button variant="ghost" onClick={() => {
        request.current?.abort();
        setBusy(false);
      }}>Cancel context loading</Button>}
    </div>}
    {busy && <p role="status">Gathering source-backed context and proposed expectations…</p>}
    {error && <p role="alert">{error}</p>}
    {board.run?.context.discovery?.status === 'failed' && <p role="alert">Additional context was unavailable. The review continues from captured evidence.</p>}
    {discovery && <>
      {discovery.summary && <p>{discovery.summary}</p>}
      <p className="rb-context-note">Available context · {discovery.generatedAt}. Existing assessments still refer to their captured review.</p>
      {discovery.status === 'empty' && <p>No source-backed criteria could be established. The review uses available code evidence and reports remaining limitations.</p>}
      {discovery.resources && discovery.resources.length > 0 && <details className="rb-context-disclosure">
        <summary>Bluebird context sources ({discovery.resources.length})</summary>
        <p className="rb-context-note">Retrieved context informs criteria; it is not proof about the captured change's revision.</p>
        <ul>{discovery.resources.map((source) => <li key={source.id}>{source.source}</li>)}</ul>
      </details>}
      {(['documented', 'inferred'] as const).map((kind) => {
        const entries = discovery.requirements.filter((entry) => entry.kind === kind);
        return entries.length > 0 && <section key={kind}>
          <h4>{kind === 'documented' ? 'Documented requirements' : 'Inferred criteria · best effort'}</h4>
          <ul className="rb-context-expectations">{entries.map((entry, index) => <li key={index}>
            <p>{entry.text}</p>
            <details className="rb-context-disclosure"><summary>Source evidence</summary>
              <p className="rb-snapshot-id">{entry.source}</p><blockquote>{entry.quote}</blockquote>
            </details>
          </li>)}</ul>
        </section>;
      })}
      {discovery.questions.length > 0 && <details className="rb-context-disclosure">
        <summary>Evidence limitations ({discovery.questions.length})</summary>
        <ul>{discovery.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
      </details>}
    </>}
  </section>;
}

export function ReviewBusinessDetails({ board, onFinding, onEvidence }: {
  board: ReviewBoard;
  onFinding: (id: string) => void;
  onEvidence: (evidence: ReviewEvidence) => void;
}) {
  const rows = board.businessMatrix ?? [];
  const requirements = board.run?.context.requirements ?? [];
  return <section className="rb-business-details" aria-label="Business requirement traceability">
    <h3>Requirement-to-behavior assessment</h3>
    <p className="rb-context-note">Read-only code assessment, not a coverage percentage. Suggested checks are not executed test results; this matrix does not certify that tests ran.</p>
    {!rows.length && <p className="rb-context-empty">No structured business assessment captured. Requirements have not been verified by this matrix.</p>}
    {rows.length > 0 && <div className="rb-table-scroll" tabIndex={0} aria-label="Requirement assessment table">
      <table className="rb-requirements-table">
        <caption>Requirements and changed behavior in the captured review</caption>
        <thead><tr><th scope="col">Requirement and source</th><th scope="col">Changed behavior and evidence</th>
          <th scope="col">Assessment</th><th scope="col">Related findings</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.requirement.id}>
          <th scope="row"><p>{row.requirement.text}</p><small>{row.requirement.id} · {row.requirement.source}</small>
            {row.requirement.priority >= 100 && <p className="rb-context-note">Best-effort inferred criterion · not documented business policy</p>}
            <p className="rb-snapshot-id">Revision {row.requirement.fingerprint} · source priority {row.requirement.priority}</p></th>
          <td><p>{row.explanation}</p><ul>{row.evidence.map((entry, index) => <li key={index}>
            <button type="button" className="rb-linkish" onClick={() => onEvidence(entry)}>{entry.source}</button> — {entry.reason}
          </li>)}</ul>{!row.evidence.length && <p>No code evidence cited.</p>}</td>
          <td>{row.assessment.replaceAll('-', ' ')}</td>
          <td>{row.findingIds.length ? <ul>{row.findingIds.map((id) => <li key={id}>
            <button type="button" className="rb-linkish" onClick={() => onFinding(id)}>Inspect finding {id}</button>
          </li>)}</ul> : 'No linked findings; this is not proof of compliance.'}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    {!rows.length && requirements.length > 0 && <ul>{requirements.map((requirement) => <li key={requirement.id}>
      <strong>{requirement.text}</strong><p>{requirement.source} · revision {requirement.fingerprint} · not assessed</p>
    </li>)}</ul>}
    {board.run?.context.warnings.length ? <section><h4>Context gaps and limitations</h4>
      <ul>{board.run.context.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></section> : null}
  </section>;
}
