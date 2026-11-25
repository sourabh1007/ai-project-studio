import { useState } from 'react';
import { Button, ErrorText } from '../../components/ui.js';
import type { FindingSeverity, ReviewBoard, ReviewFindingGroup, ReviewFindingMutation } from '../../lib/types.js';

export function ReviewFindingManagement({ board, running, onManage, onInspect }: {
  board: ReviewBoard;
  running: boolean;
  onManage?: (input: ReviewFindingMutation) => Promise<void>;
  onInspect: (group: ReviewFindingGroup) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState<FindingSeverity>('medium');
  const [decision, setDecision] = useState('dismissed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = board.uniqueFindings ?? [];
  const history = board.findingHistory ?? board.run?.findingEvents ?? [];
  const validSelected = selected.filter((id) => groups.some((group) => group.id === id));
  const canEdit = Boolean(board.run && onManage && !running && !busy);
  const apply = async (action: ReviewFindingMutation['action'], extras: Partial<ReviewFindingMutation> = {}) => {
    if (!board.run || !onManage || !canEdit) return;
    if (!reason.trim()) { setError('Give a reason for this review decision.'); return; }
    if (action !== 'undo' && validSelected.length === 0) { setError('Select at least one finding group.'); return; }
    setBusy(true);
    setError(null);
    try {
      await onManage({
        expectedRunId: board.run.id, expectedAssessmentRevision: board.run.revision,
        action, groupIds: validSelected, reason: reason.trim(), ...extras,
      });
      setSelected([]);
      setReason('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this review decision.');
    } finally { setBusy(false); }
  };
  return <section className="rb-finding-management" aria-label="Finding management and history">
    <p>Select the comments you want to update, choose one action, and explain why. Changes are saved with a history and require a new sign-off.</p>
    {!board.run && <p>Legacy findings are read-only here. Start a fresh review to record durable decisions.</p>}
    {board.possibleDuplicates?.length ? <section><h3>Possible duplicates</h3>
      <p>These are candidates, not automatic merges. Inspect the cause and correction before merging.</p>
      <ul>{board.possibleDuplicates.map((candidate, index) => <li key={index}>
        <p>{candidate.reason}</p><p>{candidate.groupIds.map((id) => groups.find((group) => group.id === id)?.finding.title ?? id).join(' · ')}</p>
        <Button disabled={!canEdit} onClick={() => setSelected(candidate.groupIds)}>Select candidate groups {index + 1}</Button>
      </li>)}</ul></section> : null}
      <fieldset disabled={!canEdit}><legend>Select review comments ({groups.length})</legend>
      {groups.map((group) => <label key={group.id} className="rb-management-group">
        <input type="checkbox" checked={validSelected.includes(group.id)} onChange={() => setSelected((previous) =>
          previous.includes(group.id) ? previous.filter((id) => id !== group.id) : [...previous, group.id])} />
        <span>{group.finding.title} <small> · {group.finding.severity} · {group.disposition ?? 'open'}</small></span>
      </label>)}
      {!groups.length && <p>No unique finding groups available.</p>}
    </fieldset>
    <ul className="rb-management-inspect">{groups.map((group) => <li key={group.id}>
      <button type="button" className="rb-linkish" onClick={() => onInspect(group)}>Inspect originals: {group.finding.title}</button>
    </li>)}</ul>
    <label>Action<select aria-label="Review decision" value={decision} disabled={!canEdit} onChange={(event) => setDecision(event.target.value)}>
      <option value="dismissed">Dismiss comments</option><option value="fix-verified">Mark fixes verified</option>
      <option value="open">Reopen comments</option>
      <option value="merge" disabled={validSelected.length < 2}>Combine duplicate comments</option>
      <option value="split" disabled={validSelected.length !== 1 || (groups.find((group) => group.id === validSelected[0])?.observations.length ?? 0) < 2}>Separate grouped observations</option>
      <option value="severity">Change severity</option>
    </select></label>
    {decision === 'severity' && <label>Severity<select aria-label="Severity override" value={severity} disabled={!canEdit}
      onChange={(event) => setSeverity(event.target.value as FindingSeverity)}>
      {(['critical', 'high', 'medium', 'low', 'suggestion'] as const).map((value) => <option key={value}>{value}</option>)}
    </select></label>}
    <p className="rb-context-note">{decision === 'fix-verified' ? 'Describe the code change and verification you checked. Posting a comment is not verification.'
      : decision === 'merge' || decision === 'split' ? 'Grouping changes presentation only. Original observations and their highest severity are preserved.'
        : decision === 'severity' ? 'Explain why the recorded impact supports this severity.'
          : decision === 'dismissed' ? 'Explain why these comments do not need a code change. Dismissal does not mean the code was fixed.'
            : 'Explain why these comments need attention again.'}</p>
    <label>Reason or verification evidence<textarea aria-label="Finding management reason" value={reason}
      disabled={!canEdit} rows={3} onChange={(event) => setReason(event.target.value)} /></label>
    <ErrorText error={error} />
    <div className="rb-finding-actions">
      <Button disabled={!canEdit || !validSelected.length || (decision === 'merge' && validSelected.length < 2) ||
        (decision === 'split' && (validSelected.length !== 1 || (groups.find((group) => group.id === validSelected[0])?.observations.length ?? 0) < 2))}
        onClick={() => void (decision === 'merge' || decision === 'split' ? apply(decision)
          : decision === 'severity' ? apply('severity', { severity })
            : apply('disposition', { disposition: decision as 'dismissed' | 'fix-verified' | 'open' }))}>Save decision</Button>
    </div>
    <details className="rb-context-disclosure"><summary>Decision history ({history.length})</summary>
    {!history.length && <p>No recorded finding decisions.</p>}
    <ol className="rb-finding-history">{history.map((event) => <li key={event.id}>
      <p><strong>{event.action}</strong>{event.disposition ? ` · ${event.disposition}` : ''}{event.severity ? ` · ${event.severity}` : ''} · <time>{event.at}</time></p>
      <p>{event.reason}</p><p>Observations: {event.observationIds.join(', ') || 'none'}</p>
      {event.targetEventId && <p>Target decision: {event.targetEventId}</p>}
      {event.action !== 'undo' && <Button disabled={!canEdit || history.some((entry) => entry.action === 'undo' && entry.targetEventId === event.id)}
        onClick={() => void apply('undo', { groupIds: [], targetEventId: event.id })}>Undo decision {event.id}</Button>}
    </li>)}</ol></details>
  </section>;
}
