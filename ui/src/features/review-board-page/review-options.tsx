import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText } from '../../components/ui.js';
import type { MetaModelOption, ReviewBoard, ReviewOptions, Skill } from '../../lib/types.js';

export function ReviewOptionsForm({ board, busy, onPrepare, businessContextDraft }: {
  board: ReviewBoard;
  busy: boolean;
  onPrepare: (options: ReviewOptions) => Promise<void>;
  businessContextDraft?: string;
}) {
  const api = useApi();
  const saved = board.run?.options;
  const perspectiveCatalog = board.availablePerspectives ?? board.model?.perspectives ?? board.perspectives;
  const [model, setModel] = useState(saved?.model ?? '');
  const [perspectiveIds, setPerspectiveIds] = useState(saved?.perspectiveIds ?? board.run?.perspectiveIds ?? board.perspectives.map((p) => p.id));
  const [skillIds, setSkillIds] = useState(saved?.skillIds ?? board.run?.context?.skills
    .filter((skill) => skill.source.startsWith('studio:')).map((skill) => skill.source.slice('studio:'.length)) ?? []);
  const [businessContext, setBusinessContext] = useState(businessContextDraft ?? saved?.businessContext ?? '');
  const [models, setModels] = useState<MetaModelOption[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.allSettled([api.getMetaModels(), api.listSkills()]).then(([catalog, instructions]) => {
      if (!active) return;
      if (catalog.status === 'fulfilled') setModels(catalog.value);
      if (instructions.status === 'fulfilled') setSkills(instructions.value.filter((s) => s.kind === 'instruction'));
      if (catalog.status === 'rejected' || instructions.status === 'rejected') {
        setCatalogError('Some options are unavailable. Retry by reopening review options.');
      }
    });
    return () => { active = false; };
  }, [api]);
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((entry) => entry !== id) : [...ids, id];
  return <form className="rb-options" onSubmit={(event) => {
    event.preventDefault();
    setError(null);
    void onPrepare({
      ...(model ? { model } : {}),
      perspectiveIds,
      skillIds,
      ...(businessContext.trim() ? { businessContext: businessContext.trim() } : {}),
    }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not prepare review.'));
  }}>
    <p>Prepare a new review without starting AI analysis. Existing results and sign-off will be invalidated.</p>
    <label>Review model
      <select aria-label="Review model" value={model} onChange={(event) => setModel(event.target.value)} disabled={busy}>
        <option value="">Use IDE default</option>
        {model && !models.some((m) => m.id === model) && <option value={model}>{model} (saved selection)</option>}
        {models.map((m) => <option key={m.id} value={m.id} disabled={!m.enabled}>
          {m.name}{m.usageLabel ? ` · ${m.usageLabel}` : ''}{!m.enabled ? ' · unavailable' : ''}
        </option>)}
      </select>
    </label>
    <fieldset disabled={busy}><legend>Perspectives</legend>
      {perspectiveCatalog.map((p) => <label key={p.id} title={p.why}>
        <input type="checkbox" checked={perspectiveIds.includes(p.id)}
          disabled={p.source === 'core'} onChange={() => setPerspectiveIds(toggle(perspectiveIds, p.id))} />{p.name}{p.source === 'core' ? ' (required)' : ''}
      </label>)}
    </fieldset>
    <fieldset disabled={busy}><legend>Studio instruction skills</legend>
      {skills.length === 0 && <p>No selectable instruction skills available. Repository guidance is collected automatically.</p>}
      {skills.map((skill) => <label key={skill.id}>
        <input type="checkbox" checked={skillIds.includes(skill.id)}
          onChange={() => setSkillIds(toggle(skillIds, skill.id))} />{skill.name}
      </label>)}
      {skillIds.filter((id) => !skills.some((skill) => skill.id === id)).map((id) => <label key={id}>
        <input type="checkbox" checked onChange={() => setSkillIds(toggle(skillIds, id))} />{id} (saved selection; unavailable)
      </label>)}
    </fieldset>
    <label>Acceptance criteria
      <textarea aria-label="Acceptance criteria" value={businessContext} disabled={busy}
        onChange={(event) => setBusinessContext(event.target.value)}
        placeholder="Expected behavior, constraints, and scenarios this PR must satisfy" rows={5} />
    </label>
    {businessContextDraft !== undefined && <p role="note">Review and edit these inferred expectations. Saving confirms the text as your requirements and prepares a new review; it does not verify the code.</p>}
    {catalogError && <p role="status">{catalogError}</p>}
    {error && <ErrorText error={error} />}
    <Button type="submit" variant="primary" disabled={busy || perspectiveIds.length === 0}>
      {busy ? 'Preparing…' : 'Save review options'}
    </Button>
  </form>;
}
