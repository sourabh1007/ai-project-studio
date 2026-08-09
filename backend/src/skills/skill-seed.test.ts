import { describe, it, expect } from 'vitest';
import type { CreateSkillInput } from './skills-contract.js';
import { BUILTIN_SKILLS, seedBuiltinSkills, type SkillSeedTarget } from './skill-seed.js';

function stub(existingNames: string[]): {
  target: SkillSeedTarget;
  created: CreateSkillInput[];
} {
  const created: CreateSkillInput[] = [];
  const target: SkillSeedTarget = {
    listSkills: () => existingNames.map((name) => ({ name })),
    createSkill: (input) => {
      created.push(input);
      return input;
    },
  };
  return { target, created };
}

describe('skill-seed', () => {
  it('ships a non-empty curated library of instruction skills with valid scopes', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.kind).toBe('instruction');
      expect(skill.instructions.length).toBeGreaterThan(0);
      expect(['feature', 'session', 'any']).toContain(skill.recommendedScope);
    }
  });

  it('seeds every built-in skill when none exist yet', () => {
    const { target, created } = stub([]);
    const count = seedBuiltinSkills(target);
    expect(count).toBe(BUILTIN_SKILLS.length);
    expect(created).toEqual([...BUILTIN_SKILLS]);
  });

  it('skips built-ins whose name already exists but seeds the rest', () => {
    const { target, created } = stub([BUILTIN_SKILLS[0].name, 'Some user skill']);
    const count = seedBuiltinSkills(target);
    expect(count).toBe(BUILTIN_SKILLS.length - 1);
    expect(created).not.toContainEqual(BUILTIN_SKILLS[0]);
    expect(created).toContainEqual(BUILTIN_SKILLS[1]);
  });

  it('seeds nothing when every built-in is already present', () => {
    const { target, created } = stub(BUILTIN_SKILLS.map((s) => s.name));
    const count = seedBuiltinSkills(target);
    expect(count).toBe(0);
    expect(created).toEqual([]);
  });
});
