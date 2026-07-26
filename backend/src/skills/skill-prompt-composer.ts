import type { SkillsConfig } from './config.js';
import type { Skill } from './skills-contract.js';

function renderSkill(skill: Skill, config: SkillsConfig): string {
  return config.skillTemplate
    .replaceAll('{{name}}', skill.name)
    .replaceAll('{{instructions}}', skill.instructions);
}

/**
 * Composes the effective `instruction` skills into a single instruction block.
 * Returns an empty string when there are no instruction skills so callers can
 * leave the prompt untouched. `task-plan` skills carry no injectable text and
 * are ignored here.
 */
export function composeInstructions(
  skills: readonly Skill[],
  config: SkillsConfig,
): string {
  const blocks = skills
    .filter((skill) => skill.kind === 'instruction' && skill.instructions.trim().length > 0)
    .map((skill) => renderSkill(skill, config));
  if (blocks.length === 0) {
    return '';
  }
  return `${config.injectionHeader}${config.skillSeparator}${blocks.join(
    config.skillSeparator,
  )}`;
}

/**
 * Prepends a composed instruction block to a user prompt. When the block is
 * empty the prompt is returned unchanged, guaranteeing sessions without skills
 * behave exactly as before.
 */
export function composeSessionPrompt(
  instructions: string,
  prompt: string,
  config: SkillsConfig,
): string {
  if (instructions.length === 0) {
    return prompt;
  }
  return `${instructions}${config.promptSeparator}${prompt}`;
}

/**
 * Composes the prompt injected into a live session when a skill is removed. A
 * skill's own `removalInstructions` win; otherwise a kind-based default is used
 * — negating an `instruction` skill or cancelling a `task-plan`.
 */
export function composeRemoval(skill: Skill, config: SkillsConfig): string {
  const custom = skill.removalInstructions.trim();
  const body =
    custom.length > 0
      ? custom
      : (skill.kind === 'task-plan'
          ? config.taskPlanRemovalTemplate
          : config.instructionRemovalTemplate
        )
          .replaceAll('{{name}}', skill.name)
          .replaceAll('{{instructions}}', skill.instructions);
  return `${config.removalHeader}${config.skillSeparator}${body}`;
}
