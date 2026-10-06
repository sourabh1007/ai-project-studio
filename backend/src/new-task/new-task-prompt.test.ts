import { describe, it, expect } from 'vitest';
import {
  applyTemplate,
  buildClarifyPrompt,
  buildDecomposePrompt,
  buildImplementPrompt,
  buildPlanPrompt,
  buildReviewPrompt,
  buildWorkerPrompt,
  parseClarifyResponse,
  parsePlanResult,
  DEFAULT_CLARIFY_PROMPT_TEMPLATE,
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
    // The planner is asked to emit the machine-read title/summary trailer.
    expect(prompt).toContain('NEWTASK-META');
  });

  describe('parsePlanResult', () => {
    it('lifts the title + summary and strips the meta trailer', () => {
      const raw =
        '## Overview\nDo the thing.\n' +
        '<!--NEWTASK-META {"title":"Add retry","summary":"Retries uploads."} -->';
      expect(parsePlanResult(raw)).toEqual({
        plan: '## Overview\nDo the thing.',
        title: 'Add retry',
        summary: 'Retries uploads.',
      });
    });

    it('keeps the last well-formed marker and ignores malformed ones', () => {
      const raw =
        'PLAN\n<!--NEWTASK-META {not json} -->\n' +
        '<!--NEWTASK-META {"title":"Final","summary":"Last wins."} -->';
      const parsed = parsePlanResult(raw);
      expect(parsed.title).toBe('Final');
      expect(parsed.summary).toBe('Last wins.');
      expect(parsed.plan).toBe('PLAN');
    });

    it('degrades to null fields when no marker is present or fields are blank', () => {
      expect(parsePlanResult('just a plan')).toEqual({
        plan: 'just a plan',
        title: null,
        summary: null,
      });
      expect(
        parsePlanResult('P <!--NEWTASK-META {"title":"  ","summary":""} -->'),
      ).toEqual({ plan: 'P', title: null, summary: null });
      // Non-string fields are ignored too.
      expect(
        parsePlanResult('P <!--NEWTASK-META {"title":1,"other":true} -->'),
      ).toEqual({ plan: 'P', title: null, summary: null });
    });

    it('accepts each field independently', () => {
      expect(
        parsePlanResult('P <!--NEWTASK-META {"summary":"Only a summary."} -->'),
      ).toEqual({ plan: 'P', title: null, summary: 'Only a summary.' });
      expect(
        parsePlanResult('P <!--NEWTASK-META {"title":"Only a title."} -->'),
      ).toEqual({ plan: 'P', title: 'Only a title.', summary: null });
    });
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

  it('builds a clarify prompt from trimmed inputs', () => {
    const prompt = buildClarifyPrompt(DEFAULT_CLARIFY_PROMPT_TEMPLATE, {
      problem: '  make it faster  ',
      context: '  the list view  ',
    });
    expect(prompt).toContain('make it faster');
    expect(prompt).toContain('the list view');
    expect(prompt).not.toContain(NO_CONTEXT_MARKER);
  });

  it('falls back to the marker when clarify context is blank', () => {
    const prompt = buildClarifyPrompt(DEFAULT_CLARIFY_PROMPT_TEMPLATE, {
      problem: 'p',
      context: '   ',
    });
    expect(prompt).toContain(NO_CONTEXT_MARKER);
  });

  it('parses a clarify response, trimming and dropping blanks/non-strings', () => {
    const parsed = parseClarifyResponse(
      'Here you go:\n```json\n{"improvedProblem":"  Clear ask  ","missingInfo":["  affected files  ","", 7, "edge cases"]}\n```',
      'original',
    );
    expect(parsed.improvedProblem).toBe('Clear ask');
    expect(parsed.missingInfo).toEqual(['affected files', 'edge cases']);
  });

  it('clarify parse degrades to the fallback on malformed or non-object output', () => {
    expect(parseClarifyResponse('no json here', '  fallback  ')).toEqual({
      improvedProblem: 'fallback',
      missingInfo: [],
    });
    expect(parseClarifyResponse('{bad json}', 'fb')).toEqual({
      improvedProblem: 'fb',
      missingInfo: [],
    });
    expect(parseClarifyResponse('[1,2,3]', 'fb')).toEqual({
      improvedProblem: 'fb',
      missingInfo: [],
    });
    expect(parseClarifyResponse('null', 'fb')).toEqual({
      improvedProblem: 'fb',
      missingInfo: [],
    });
  });

  it('clarify parse keeps the fallback when improvedProblem is blank or missing', () => {
    expect(
      parseClarifyResponse('{"improvedProblem":"   ","missingInfo":[]}', 'fb'),
    ).toEqual({ improvedProblem: 'fb', missingInfo: [] });
    expect(
      parseClarifyResponse('{"missingInfo":["x"]}', 'fb'),
    ).toEqual({ improvedProblem: 'fb', missingInfo: ['x'] });
    expect(
      parseClarifyResponse('{"improvedProblem":"ok"}', 'fb'),
    ).toEqual({ improvedProblem: 'ok', missingInfo: [] });
  });
});
