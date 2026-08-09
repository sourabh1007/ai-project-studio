import type { ReactNode } from 'react';
import type { SkillKind, SkillRecommendedScope } from '../../lib/types.js';
import {
  InstructionSkillIcon,
  TaskPlanSkillIcon,
} from '../../components/icons.js';

interface KindMeta {
  label: string;
  icon: (props: { size?: number }) => ReactNode;
}

const KINDS: Record<SkillKind, KindMeta> = {
  instruction: { label: 'Instruction', icon: InstructionSkillIcon },
  'task-plan': { label: 'Task plan', icon: TaskPlanSkillIcon },
};

export const SKILL_KINDS: SkillKind[] = ['instruction', 'task-plan'];

export function skillKindLabel(kind: SkillKind): string {
  return KINDS[kind]?.label ?? kind;
}

export function SkillKindIcon({
  kind,
  size = 14,
}: {
  kind: SkillKind;
  size?: number;
}) {
  const Icon = (KINDS[kind] ?? KINDS.instruction).icon;
  return <Icon size={size} />;
}

const SCOPE_LABELS: Record<SkillRecommendedScope, string> = {
  feature: 'Feature',
  session: 'Session',
  any: 'Any',
};

export const SKILL_RECOMMENDED_SCOPES: SkillRecommendedScope[] = [
  'any',
  'feature',
  'session',
];

export function skillScopeLabel(scope: SkillRecommendedScope): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export function SkillScopeBadge({ scope }: { scope: SkillRecommendedScope }) {
  return (
    <span
      className={`skill-scope-badge skill-scope-badge-${scope}`}
      title={`Recommended for: ${skillScopeLabel(scope)}`}
    >
      {skillScopeLabel(scope)}
    </span>
  );
}
