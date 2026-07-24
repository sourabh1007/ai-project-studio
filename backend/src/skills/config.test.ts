import { describe, it, expect } from 'vitest';
import { skillsConfigSchema, skillsDefaults, SKILLS_NAMESPACE } from './config.js';

describe('skills config', () => {
  it('exposes a namespace and valid defaults', () => {
    expect(SKILLS_NAMESPACE).toBe('skills');
    expect(() => skillsConfigSchema.parse(skillsDefaults)).not.toThrow();
  });

  it('rejects a non-positive name length', () => {
    expect(() =>
      skillsConfigSchema.parse({ ...skillsDefaults, maxNameLength: 0 }),
    ).toThrow();
  });

  it('rejects an empty injection header', () => {
    expect(() =>
      skillsConfigSchema.parse({ ...skillsDefaults, injectionHeader: '' }),
    ).toThrow();
  });
});
