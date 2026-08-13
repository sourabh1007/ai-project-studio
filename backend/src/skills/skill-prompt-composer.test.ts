import { describe, it, expect } from 'vitest';
import {
  composeInstructions,
  composeRemoval,
  composeSessionPrompt,
} from './skill-prompt-composer.js';
import { skillsDefaults } from './config.js';
import type { Skill } from './skills-contract.js';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: 'k1',
    name: 'Testing',
    kind: 'instruction',
    instructions: 'Always write tests.',
    removalInstructions: '',
    recommendedScope: 'any',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('composeInstructions', () => {
  it('returns an empty string when there are no skills', () => {
    expect(composeInstructions([], skillsDefaults)).toBe('');
  });

  it('ignores task-plan skills and skills with blank instructions', () => {
    const skills = [
      skill({ id: 'a', kind: 'task-plan', instructions: 'ignored' }),
      skill({ id: 'b', instructions: '   ' }),
    ];
    expect(composeInstructions(skills, skillsDefaults)).toBe('');
  });

  it('renders a header and one block per instruction skill', () => {
    const result = composeInstructions(
      [
        skill({ id: 'a', name: 'A', instructions: 'Do A.' }),
        skill({ id: 'b', name: 'B', instructions: 'Do B.' }),
      ],
      skillsDefaults,
    );
    expect(result).toContain(skillsDefaults.injectionHeader);
    expect(result).toContain('## A');
    expect(result).toContain('Do A.');
    expect(result).toContain('## B');
    expect(result).toContain('Do B.');
  });
});

describe('composeSessionPrompt', () => {
  it('returns the prompt unchanged when there are no instructions', () => {
    expect(composeSessionPrompt('', 'user prompt', skillsDefaults)).toBe(
      'user prompt',
    );
  });

  it('prepends the instructions with the configured separator', () => {
    const result = composeSessionPrompt('BLOCK', 'user prompt', skillsDefaults);
    expect(result).toBe(`BLOCK${skillsDefaults.promptSeparator}user prompt`);
  });
});

describe('composeRemoval', () => {
  it('negates an instruction skill by default, echoing its guidance', () => {
    const result = composeRemoval(
      skill({ name: 'Concise', instructions: 'Be concise.' }),
      skillsDefaults,
    );
    expect(result).toContain(skillsDefaults.removalHeader);
    expect(result).toContain('Stop following the "Concise" skill');
    expect(result).toContain('Be concise.');
  });

  it('cancels a task-plan skill by default, referencing only its name', () => {
    const result = composeRemoval(
      skill({ kind: 'task-plan', name: 'Push Plan', instructions: 'SENTINEL_BODY' }),
      skillsDefaults,
    );
    expect(result).toContain('Cancel the "Push Plan" plan');
    expect(result).not.toContain('SENTINEL_BODY');
  });

  it("prefers the skill's own removal reaction when provided", () => {
    const result = composeRemoval(
      skill({ removalInstructions: '  Undo everything you just did.  ' }),
      skillsDefaults,
    );
    expect(result).toContain(skillsDefaults.removalHeader);
    expect(result).toContain('Undo everything you just did.');
    expect(result).not.toContain('Stop following');
  });
});
