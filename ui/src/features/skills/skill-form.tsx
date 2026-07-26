import { useState } from 'react';
import type { Skill, SkillKind } from '../../lib/types.js';
import { Button, ErrorText } from '../../components/ui.js';
import { SKILL_KINDS, skillKindLabel } from './skill-kind.js';

/**
 * Create/edit form for a reusable skill. Extracted so it can be reused both by
 * the central Skills manager and the inline "add skill" flow on a feature or
 * session, keeping validation and layout consistent across entry points.
 */
export function SkillForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Skill;
  submitLabel?: string;
  onSubmit: (input: {
    name: string;
    kind: SkillKind;
    instructions: string;
  }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<SkillKind>(initial?.kind ?? 'instruction');
  const [instructions, setInstructions] = useState(initial?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), kind, instructions });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feature-form">
      <div className="field">
        <label htmlFor="skill-name">Name</label>
        <input
          id="skill-name"
          className="input"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Follow TDD"
        />
      </div>
      <div className="field">
        <label htmlFor="skill-kind">Kind</label>
        <select
          id="skill-kind"
          className="input"
          value={kind}
          disabled={Boolean(initial)}
          onChange={(event) => setKind(event.target.value as SkillKind)}
        >
          {SKILL_KINDS.map((k) => (
            <option key={k} value={k}>
              {skillKindLabel(k)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="skill-instructions">Instructions</label>
        <textarea
          id="skill-instructions"
          className="textarea textarea-lg"
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Guidance injected into every session this skill is tagged to…"
        />
      </div>
      <ErrorText error={error} />
      <div className="row modal-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : (submitLabel ?? (initial ? 'Save changes' : 'Create skill'))}
        </Button>
      </div>
    </div>
  );
}
