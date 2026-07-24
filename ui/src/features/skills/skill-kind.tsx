import type { ReactNode } from 'react';
import type { SkillKind } from '../../lib/types.js';
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
