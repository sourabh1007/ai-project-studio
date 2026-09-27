import { describe, expect, it } from 'vitest';
import {
  buildReviewPrompt,
  COMMON_PROMPT_PLACEHOLDERS,
  DEFAULT_COMMON_REVIEW_GUIDANCE,
  DEFAULT_PERSPECTIVE_PROMPTS,
  PERSPECTIVE_CONFIG_KEYS,
  PERSPECTIVE_LABELS,
  RESPONSE_ENVELOPE,
  REVIEW_PERSPECTIVE_IDS,
} from './review-board-perspective-prompts.js';

describe('review-board perspective prompt system', () => {
  it('fixes exact location guidance in the non-editable response contract', () => {
    expect(RESPONSE_ENVELOPE).toContain('"location": { "path": "<repo-relative path>", "line": 1');
    expect(RESPONSE_ENVELOPE).toContain('"side": "RIGHT" | "LEFT"');
    expect(RESPONSE_ENVELOPE).toContain('ONLY when exact coordinates are known from the captured diff');
    expect(RESPONSE_ENVELOPE).toContain('set "location" to null or omit it. Never invent coordinates');
    expect(RESPONSE_ENVELOPE).toContain('Deletions belong on LEFT');
    expect(RESPONSE_ENVELOPE).toContain('Keep "source" as the human-readable citation');
  });
  it('defines a bespoke, non-empty focus and issue format for every lens', () => {
    for (const id of REVIEW_PERSPECTIVE_IDS) {
      const parts = DEFAULT_PERSPECTIVE_PROMPTS[id];
      expect(parts.focus.trim().length).toBeGreaterThan(0);
      expect(parts.issueFormat.trim().length).toBeGreaterThan(0);
      expect(PERSPECTIVE_LABELS[id].length).toBeGreaterThan(0);
      const keys = PERSPECTIVE_CONFIG_KEYS[id];
      expect(keys.focus.endsWith('Focus')).toBe(true);
      expect(keys.issueFormat.endsWith('IssueFormat')).toBe(true);
    }
  });

  it('exposes unique config keys across all lenses', () => {
    const keys = REVIEW_PERSPECTIVE_IDS.flatMap((id) => [
      PERSPECTIVE_CONFIG_KEYS[id].focus,
      PERSPECTIVE_CONFIG_KEYS[id].issueFormat,
    ]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('names the primary languages and config formats in the common guidance', () => {
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('C#');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('C++');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('Java');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('XML');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('YAML');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).toContain('{{lensName}}');
  });

  it('lists the common placeholders the focus sections can use', () => {
    expect(COMMON_PROMPT_PLACEHOLDERS).toContain('lensName');
    expect(COMMON_PROMPT_PLACEHOLDERS).toContain('changedFiles');
  });

  it('assembles the three sections then the fixed response envelope', () => {
    const prompt = buildReviewPrompt({
      common: 'COMMON for {{lensName}}',
      focus: 'FOCUS on {{prTitle}}',
      issueFormat: 'FORMAT',
      vars: { lensName: 'Security', prTitle: 'Add caching' },
    });
    expect(prompt).toContain('COMMON for Security');
    expect(prompt).toContain('FOCUS on Add caching');
    expect(prompt).toContain('FORMAT');
    expect(prompt).toContain('## Response format');
    expect(prompt).toContain('"skipped": boolean');
    // Order: common, focus, issue format, envelope.
    expect(prompt.indexOf('COMMON')).toBeLessThan(prompt.indexOf('FOCUS'));
    expect(prompt.indexOf('FOCUS')).toBeLessThan(prompt.indexOf('FORMAT'));
    expect(prompt.indexOf('FORMAT')).toBeLessThan(
      prompt.indexOf('## Response format'),
    );
  });

  it('leaves unreferenced placeholders untouched', () => {
    const prompt = buildReviewPrompt({
      common: 'C',
      focus: 'F {{distilledProblem}}',
      issueFormat: 'I',
      vars: {},
    });
    expect(prompt).toContain('{{distilledProblem}}');
  });

  it('keeps the response envelope out of the editable sections', () => {
    expect(RESPONSE_ENVELOPE).toContain('"findings"');
    expect(DEFAULT_COMMON_REVIEW_GUIDANCE).not.toContain('## Response format');
  });

  it("fills the problem-solution focus's extra placeholders", () => {
    const prompt = buildReviewPrompt({
      common: DEFAULT_COMMON_REVIEW_GUIDANCE,
      focus: DEFAULT_PERSPECTIVE_PROMPTS['problem-solution'].focus,
      issueFormat: DEFAULT_PERSPECTIVE_PROMPTS['problem-solution'].issueFormat,
      vars: {
        distilledProblem: 'Reads are slow.',
        solutionDigest: 'Adds a read-through cache.',
      },
    });
    expect(prompt).toContain('Reads are slow.');
    expect(prompt).toContain('Adds a read-through cache.');
  });
});
