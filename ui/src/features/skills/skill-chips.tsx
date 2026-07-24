import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { SkillScope } from '../../lib/types.js';
import { SkillKindIcon } from './skill-kind.js';

/**
 * Read-only, compact rendering of the skills tagged to a feature or session,
 * shown as pill/chip tags (kind icon + accent + name). Used in the Explorer
 * left panel where tagging happens elsewhere; renders nothing when untagged.
 */
export function SkillChips({
  scope,
  targetId,
  reloadSignal,
}: {
  scope: SkillScope;
  targetId: string;
  reloadSignal?: unknown;
}) {
  const api = useApi();
  const tagged = useAsync(
    () =>
      scope === 'feature'
        ? api.listFeatureSkills(targetId)
        : api.listSessionSkills(targetId),
    [scope, targetId, reloadSignal],
  );

  const skills = tagged.data ?? [];
  if (skills.length === 0) {
    return null;
  }

  return (
    <div className="skill-chips" aria-label="Tagged skills">
      {skills.map((skill) => (
        <span
          key={skill.attachmentId}
          className={`skill-chip skill-chip-${skill.kind} skill-chip-sm`}
          title={`${skill.name} (${skill.kind})`}
        >
          <SkillKindIcon kind={skill.kind} />
          {skill.name}
        </span>
      ))}
    </div>
  );
}
