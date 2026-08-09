import { useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { SkillScope } from '../../lib/types.js';
import { ErrorText } from '../../components/ui.js';
import { CloseIcon, PlusIcon, TagIcon } from '../../components/icons.js';
import { SkillKindIcon, SkillScopeBadge } from './skill-kind.js';

/**
 * Compact control to tag/untag skills from the central library to a single
 * feature or session. Renders tagged skills as removable chips plus an inline
 * picker to attach another skill from the library.
 */
export function SkillTagger({
  scope,
  targetId,
  label,
  onChange,
}: {
  scope: SkillScope;
  targetId: string;
  label?: string;
  onChange?: () => void;
}) {
  const api = useApi();
  const library = useAsync(() => api.listSkills(), []);
  const tagged = useAsync(
    () =>
      scope === 'feature'
        ? api.listFeatureSkills(targetId)
        : api.listSessionSkills(targetId),
    [scope, targetId],
  );
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const taggedIds = new Set((tagged.data ?? []).map((s) => s.id));
  // Only offer skills recommended for this scope (feature/session). Skills
  // marked 'any' fit both, so they appear in every picker.
  const available = (library.data ?? []).filter(
    (s) =>
      !taggedIds.has(s.id) &&
      (s.recommendedScope === scope || s.recommendedScope === 'any'),
  );

  async function tag(skillId: string) {
    setError(null);
    try {
      await api.tagSkill(skillId, scope, targetId);
      setAdding(false);
      tagged.reload();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function untag(attachmentId: string) {
    setError(null);
    try {
      await api.untagSkill(attachmentId);
      tagged.reload();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="skill-tagger">
      <div className="skill-tagger-head">
        <span className="skill-tagger-label">
          <TagIcon size={13} /> {label ?? 'Skills'}
        </span>
        <button
          type="button"
          className="tree-action"
          title="Add skill"
          aria-label="Add skill"
          disabled={available.length === 0}
          onClick={() => setAdding((v) => !v)}
        >
          <PlusIcon />
        </button>
      </div>

      <div className="skill-tag-row">
        {(tagged.data ?? []).map((skill) => (
          <span key={skill.attachmentId} className={`skill-chip skill-chip-${skill.kind}`}>
            <SkillKindIcon kind={skill.kind} />
            {skill.name}
            <button
              type="button"
              className="skill-chip-remove"
              title={`Remove ${skill.name}`}
              aria-label={`Remove ${skill.name}`}
              onClick={() => void untag(skill.attachmentId)}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        ))}
        {!tagged.loading && (tagged.data ?? []).length === 0 && !adding && (
          <span className="skill-tagger-empty">None</span>
        )}
      </div>

      {adding && (
        <div className="skill-tag-picker">
          {available.map((skill) => (
            <button
              key={skill.id}
              type="button"
              className={`skill-chip skill-chip-${skill.kind} skill-chip-add`}
              onClick={() => void tag(skill.id)}
            >
              <SkillKindIcon kind={skill.kind} />
              {skill.name}
              <SkillScopeBadge scope={skill.recommendedScope} />
            </button>
          ))}
        </div>
      )}

      <ErrorText error={error ?? library.error ?? tagged.error} />
    </div>
  );
}
