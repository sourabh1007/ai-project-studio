import { describe, it, expect } from 'vitest';
import { parseTaskPlan } from './task-plan-parser.js';
import { featureTasksDefaults } from './config.js';

const config = featureTasksDefaults;

describe('parseTaskPlan', () => {
  it('parses a strict JSON array of task objects', () => {
    const text = JSON.stringify([
      { title: 'Add form', detail: 'email + password' },
      { title: 'Wire submit' },
    ]);
    expect(parseTaskPlan(text, config)).toEqual([
      { title: 'Add form', detail: 'email + password' },
      { title: 'Wire submit', detail: '' },
    ]);
  });

  it('parses an array of plain strings', () => {
    expect(parseTaskPlan('["First", "Second"]', config)).toEqual([
      { title: 'First', detail: '' },
      { title: 'Second', detail: '' },
    ]);
  });

  it('extracts a JSON array embedded in surrounding prose', () => {
    const text = 'Sure! Here is the plan:\n[{"title":"Do it"}]\nHope that helps.';
    expect(parseTaskPlan(text, config)).toEqual([{ title: 'Do it', detail: '' }]);
  });

  it('reads alternate title and detail keys', () => {
    const text = JSON.stringify([{ name: 'Named', notes: 'via notes' }]);
    expect(parseTaskPlan(text, config)).toEqual([
      { title: 'Named', detail: 'via notes' },
    ]);
  });

  it('drops blank titles and non-object entries', () => {
    const text = JSON.stringify(['', { detail: 'no title' }, 42, { title: 'Keep' }]);
    expect(parseTaskPlan(text, config)).toEqual([{ title: 'Keep', detail: '' }]);
  });

  it('caps the number of tasks at maxTasks', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}` }));
    const result = parseTaskPlan(JSON.stringify(many), config);
    expect(result).toHaveLength(config.maxTasks);
  });

  it('clamps long titles to maxTitleLength', () => {
    const long = 'a'.repeat(config.maxTitleLength + 50);
    const result = parseTaskPlan(JSON.stringify([{ title: long }]), config);
    expect(result[0].title).toHaveLength(config.maxTitleLength);
  });

  it('returns an empty array when the text is not JSON', () => {
    expect(parseTaskPlan('the model refused', config)).toEqual([]);
  });

  it('returns an empty array when JSON is not an array', () => {
    expect(parseTaskPlan('{"title":"x"}', config)).toEqual([]);
  });
});
