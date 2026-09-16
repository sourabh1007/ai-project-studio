import { describe, it, expect } from 'vitest';
import {
  applyTemplate,
  buildDecomposePrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkerPrompt,
  DEFAULT_DECOMPOSE_PROMPT_TEMPLATE,
  DEFAULT_IMPLEMENT_PROMPT_TEMPLATE,
  DEFAULT_PLAN_PROMPT_TEMPLATE,
  DEFAULT_REVIEW_PROMPT_TEMPLATE,
  DEFAULT_WORKER_PROMPT_TEMPLATE,
  NO_CONTEXT_MARKER,
} from './new-task-prompt.js';

describe('new-task-prompt', () => {
  it('substitutes every placeholder and leaves unknown ones intact', () => {
    expect(applyTemplate('{{a}}-{{b}}-{{a}}', { a: 'x', b: 'y' })).toBe(
      'x-y-x',
    );
    expect(applyTemplate('{{missing}}', { a: 'x' })).toBe('{{missing}}');
  });

  it('builds a plan prompt from trimmed inputs', () => {
    const prompt = buildPlanPrompt(DEFAULT_PLAN_PROMPT_TEMPLATE, {
      problem: '  slow query  ',
      context: '  on the dashboard  ',
    });
    expect(prompt).toContain('slow query');
    expect(prompt).toContain('on the dashboard');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('falls back to a marker when context is blank', () => {
    const prompt = buildPlanPrompt(DEFAULT_PLAN_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '   ',
    });
    expect(prompt).toContain(NO_CONTEXT_MARKER);
  });

  it('folds reviewer feedback in after the existing context', () => {
    const prompt = buildPlanPrompt(DEFAULT_PLAN_PROMPT_TEMPLATE, {
      problem: 'p',
      context: 'existing context',
      suggestion: '  handle the empty case  ',
    });
    expect(prompt).toContain('existing context');
    expect(prompt).toContain('Reviewer feedback on the previous plan to address:');
    expect(prompt).toContain('handle the empty case');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('uses reviewer feedback alone when there is no context', () => {
    const prompt = buildPlanPrompt(DEFAULT_PLAN_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '',
      suggestion: 'be more specific',
    });
    expect(prompt).toContain('be more specific');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('builds an implement prompt including the plan', () => {
    const prompt = buildImplementPrompt(DEFAULT_IMPLEMENT_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '',
      plan: '  step 1  ',
    });
    expect(prompt).toContain('step 1');
    expect(prompt).toContain(NO_CONTEXT_MARKER);
  });

  it('builds a decompose prompt with the worker budget and context', () => {
    const prompt = buildDecomposePrompt(DEFAULT_DECOMPOSE_PROMPT_TEMPLATE, {
      problem: '  split me  ',
      context: '  extra  ',
      plan: '  the plan  ',
      maxWorkers: 3,
    });
    expect(prompt).toContain('split me');
    expect(prompt).toContain('extra');
    expect(prompt).toContain('the plan');
    expect(prompt).toContain('1 and 3 slices');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('falls back to the marker when decompose context is blank', () => {
    const prompt = buildDecomposePrompt(DEFAULT_DECOMPOSE_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '  ',
      plan: 'plan',
      maxWorkers: 2,
    });
    expect(prompt).toContain(NO_CONTEXT_MARKER);
  });

  it('builds a sub-agent prompt listing the assigned files and role', () => {
    const prompt = buildWorkerPrompt(DEFAULT_WORKER_PROMPT_TEMPLATE, {
      problem: 'p',
      context: 'c',
      plan: 'plan',
      title: '  Slice A  ',
      description: '  do A  ',
      files: ['src/a.ts', 'src/b.ts'],
      role: 'tester',
    });
    expect(prompt).toContain('Slice A');
    expect(prompt).toContain('do A');
    expect(prompt).toContain('- src/a.ts');
    expect(prompt).toContain('- src/b.ts');
    expect(prompt).toContain('tester sub-agent');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('sub-agent prompt notes no files, blank context, and defaults the role', () => {
    const prompt = buildWorkerPrompt(DEFAULT_WORKER_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '',
      plan: 'plan',
      title: 'T',
      description: '',
      files: [],
      role: '  ',
    });
    expect(prompt).toContain('no specific files were assigned');
    expect(prompt).toContain('developer sub-agent');
    expect(prompt).toContain(NO_CONTEXT_MARKER);
  });

  it('builds a review prompt from the inputs and plan', () => {
    const withContext = buildReviewPrompt(DEFAULT_REVIEW_PROMPT_TEMPLATE, {
      problem: '  verify  ',
      context: '  ctx  ',
      plan: '  plan  ',
    });
    expect(withContext).toContain('verify');
    expect(withContext).toContain('ctx');
    expect(withContext).toContain('plan');
    expect(withContext).not.toContain(NO_CONTEXT_MARKER);

    const blank = buildReviewPrompt(DEFAULT_REVIEW_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '',
      plan: 'plan',
    });
    expect(blank).toContain(NO_CONTEXT_MARKER);
  });
});
