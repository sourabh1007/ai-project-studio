import { useMemo, useState } from 'react';
import { evidencePath } from '../../lib/review-format.js';
import type { ReviewBoard } from '../../lib/types.js';
import { ExecutionTimeline, InsightMatrix } from '../monitoring/insights.js';

export function reviewAttentionByPath(board: ReviewBoard): Record<string, number> {
  const result = new Map<string, Set<string>>();
  const groups = board.uniqueFindings ?? board.perspectives.flatMap((p) => p.findings.map((finding) => ({
    id: `${p.id}/${finding.id}`, finding, observations: [finding],
  })));
  for (const group of groups) for (const observation of [group.finding, ...group.observations]) {
    for (const evidence of observation.evidence) {
      const path = evidence.location?.path ?? evidencePath(evidence.source);
      if (!path) continue;
      const ids = result.get(path) ?? new Set<string>();
      ids.add(group.id); result.set(path, ids);
    }
  }
  return Object.fromEntries([...result].map(([path, ids]) => [path, ids.size]));
}

export function ReviewInsights({ board, onFilter }: {
  board: ReviewBoard;
  onFilter?: (filter: { file?: string; perspective?: string; skill?: string; requirement?: string }) => void;
}) {
  const [view, setView] = useState('attention');
  const groups = useMemo(() => board.uniqueFindings ?? board.perspectives.flatMap((perspective) =>
    perspective.findings.map((finding) => ({
      id: `${perspective.id}/${finding.id}`, finding, observations: [finding],
      perspectiveIds: [perspective.id], skillIds: finding.skillIds ?? [],
    }))), [board]);
  const index = useMemo(() => {
    const attention = new Map<string, Set<string>>();
    const skills = new Map<string, Set<string>>();
    const files = new Set<string>();
    const add = (map: Map<string, Set<string>>, subject: string, perspective: string, group: string) => {
      const key = JSON.stringify([subject, perspective]);
      const values = map.get(key) ?? new Set<string>();
      values.add(group); map.set(key, values);
    };
    for (const group of groups) for (const finding of [group.finding, ...group.observations]) {
      const paths = [...new Set(finding.evidence.map((entry) => entry.location?.path ?? evidencePath(entry.source))
        .filter((path): path is string => !!path))];
      for (const file of paths.length ? paths : ['Unlocated']) {
        files.add(file); add(attention, file, finding.perspectiveId, group.id);
      }
      for (const skill of finding.skillIds ?? []) add(skills, skill, finding.perspectiveId, group.id);
    }
    return { attention, skills, files: [...files].sort() };
  }, [groups]);
  const perspectives = board.perspectives;
  return <section aria-label="Review insights">
    <p className="field-hint">Run: {board.run?.id ?? 'Legacy snapshot'} · revision {board.run?.revision ?? 'unavailable'} · {groups.length} unique groups.
      A group can appear in several cells; cells are not additive.</p>
    <label>Review insight <select className="input" value={view} onChange={(event) => setView(event.target.value)}>
      <option value="attention">Review attention</option><option value="skills">Skill provenance</option>
      <option value="business">Business requirements</option><option value="timeline">Run timing</option>
    </select></label>
    {view === 'attention' && <InsightMatrix title="File by perspective" columns={perspectives.map((p) => p.name)}
      explanation="Linked unique groups, not defect density or coverage. Zero means no linked findings; file inspection is not evidenced. Unlocated concerns are not assigned to a guessed file."
      rows={index.files.map((file) => ({ id: file, label: file, cells: perspectives.map((perspective) => {
        const count = index.attention.get(JSON.stringify([file, perspective.id]))?.size ?? 0;
        return { value: count, text: count ? String(count) : `0 · ${perspective.status}`,
          state: perspective.status,
          select: onFilter ? () => onFilter({ file: file === 'Unlocated' ? '__unlocated' : file, perspective: perspective.id }) : undefined };
      }) }))} />}
    {view === 'skills' && <InsightMatrix title="Skills by perspective" columns={perspectives.map((p) => p.name)}
      explanation="Unique groups citing the captured skill. Supplied does not mean invoked or followed, and citation does not prove that the skill caused discovery."
      rows={(board.run?.context.skills ?? []).map((skill) => ({ id: skill.id, label: `${skill.name} · ${skill.source} · ${skill.fingerprint}`,
        cells: perspectives.map((p) => ({
          value: index.skills.get(JSON.stringify([skill.id, p.id]))?.size ?? 0,
          select: onFilter ? () => onFilter({ skill: skill.id, perspective: p.id }) : undefined,
        })) }))} />}
    {view === 'business' && <InsightMatrix title="Business traceability" columns={['Assessment', 'Linked groups']}
      explanation="Captured source/content-bound requirements. Not assessed is not supported. Changed versions are never matched by wording."
      rows={(board.businessMatrix ?? []).map((row) => {
        const count = groups.filter((group) => [group.finding, ...group.observations]
          .some((finding) => row.findingIds.includes(finding.id) || finding.requirementIds?.includes(row.requirement.id))).length;
        return { id: row.requirement.id, label: `${row.requirement.text} · ${row.requirement.source}`,
          cells: [{ value: null, text: row.assessment, state: row.assessment },
            { value: count, select: onFilter ? () => onFilter({ requirement: row.requirement.id }) : undefined }] };
      })} />}
    {view === 'timeline' && <ExecutionTimeline items={board.run ? [{
      id: board.run.id, label: `Review · ${board.run.model}`, status: board.run.status,
      start: Date.parse(board.run.startedAt), end: board.run.finishedAt ? Date.parse(board.run.finishedAt) : null,
    }] : []} />}
  </section>;
}
