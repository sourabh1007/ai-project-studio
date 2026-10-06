import { describe, it, expect } from 'vitest';
import { stripPlanPreamble } from './plan-format.js';

describe('stripPlanPreamble', () => {
  it('drops narrative before the first heading', () => {
    const plan =
      "I'll investigate the code. Let me read the manifests.\n\n## Overview\nKeep it simple.";
    expect(stripPlanPreamble(plan)).toBe('## Overview\nKeep it simple.');
  });

  it('returns the text unchanged when it already starts with a heading', () => {
    const plan = '## Overview\nDo the thing.';
    expect(stripPlanPreamble(plan)).toBe('## Overview\nDo the thing.');
  });

  it('keeps text that has no heading', () => {
    const plan = 'Just a sentence with no heading at all.';
    expect(stripPlanPreamble(plan)).toBe(
      'Just a sentence with no heading at all.',
    );
  });

  it('does not treat inline hashes as headings', () => {
    const plan = 'Refers to #(SETTINGS_REF) and #1 ticket.\n\n# Plan\nStep.';
    expect(stripPlanPreamble(plan)).toBe('# Plan\nStep.');
  });

  it('returns empty for blank input', () => {
    expect(stripPlanPreamble('   ')).toBe('');
    expect(stripPlanPreamble('')).toBe('');
    expect(stripPlanPreamble(undefined as unknown as string)).toBe('');
  });

  it('matches any ATX level from the start of a line', () => {
    const plan = 'preamble\n###### Deep\nbody';
    expect(stripPlanPreamble(plan)).toBe('###### Deep\nbody');
  });
});
