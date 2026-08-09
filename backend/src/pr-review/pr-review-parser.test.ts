import { describe, expect, it } from 'vitest';
import {
  classifyCategory,
  isFileExplained,
  parseFileExplanation,
  parseProblemStatement,
  UNEXPLAINED_WHAT_CHANGED,
  UNEXPLAINED_WHAT_IT_DOES,
} from './pr-review-parser.js';

describe('parseProblemStatement', () => {
  it('strips the heading and keeps the body', () => {
    const parsed = parseProblemStatement(
      '## Problem Statement\nRequests fail transiently.',
    );
    expect(parsed.content).toBe('Requests fail transiently.');
    expect(parsed.sufficient).toBe(true);
  });

  it('reports insufficiency without inventing a problem', () => {
    const parsed = parseProblemStatement(
      'INSUFFICIENT: the description is empty',
    );
    expect(parsed.sufficient).toBe(false);
    expect(parsed.content).toBe('the description is empty');
  });

  it('returns null content when the body is blank', () => {
    const parsed = parseProblemStatement('## Problem Statement\n   ');
    expect(parsed.content).toBeNull();
    expect(parsed.sufficient).toBe(true);
  });
});

describe('parseFileExplanation', () => {
  it('reads whatItDoes, whatChanged and a review finding list from a JSON object', () => {
    const parsed = parseFileExplanation(
      '```json\n{ "whatItDoes": "runs things", "whatChanged": "adds a flag", ' +
        '"review": ["null default is unchecked", "- naming is terse"] }\n```',
    );
    expect(parsed).toEqual({
      whatItDoes: 'runs things',
      whatChanged: 'adds a flag',
      review: ['null default is unchecked', 'naming is terse'],
    });
  });

  it('treats an empty review array as a clean, no-issue result', () => {
    const parsed = parseFileExplanation(
      '{ "whatItDoes": "runs things", "whatChanged": "adds a flag", "review": [] }',
    );
    expect(parsed.review).toEqual([]);
  });

  it('splits a stringly-typed review into findings when the model ignores the array contract', () => {
    const parsed = parseFileExplanation(
      '{ "whatItDoes": "x", "whatChanged": "y", "review": "first issue\\nsecond issue" }',
    );
    expect(parsed.review).toEqual(['first issue', 'second issue']);
  });

  it('falls back to placeholders and an empty finding list when fields are missing or unparseable', () => {
    expect(parseFileExplanation('not json')).toEqual({
      whatItDoes: UNEXPLAINED_WHAT_IT_DOES,
      whatChanged: UNEXPLAINED_WHAT_CHANGED,
      review: [],
    });
    expect(parseFileExplanation('{ this is not: valid json }')).toEqual({
      whatItDoes: UNEXPLAINED_WHAT_IT_DOES,
      whatChanged: UNEXPLAINED_WHAT_CHANGED,
      review: [],
    });
    expect(parseFileExplanation('{ "whatItDoes": "only this" }')).toEqual({
      whatItDoes: 'only this',
      whatChanged: UNEXPLAINED_WHAT_CHANGED,
      review: [],
    });
  });
});

describe('isFileExplained', () => {
  it('is true only when both text fields are real, non-placeholder text', () => {
    expect(
      isFileExplained({
        whatItDoes: 'does',
        whatChanged: 'changed',
      }),
    ).toBe(true);
    expect(
      isFileExplained({
        whatItDoes: UNEXPLAINED_WHAT_IT_DOES,
        whatChanged: 'changed',
      }),
    ).toBe(false);
    expect(
      isFileExplained({
        whatItDoes: 'does',
        whatChanged: UNEXPLAINED_WHAT_CHANGED,
      }),
    ).toBe(false);
    expect(
      isFileExplained({ whatItDoes: '  ', whatChanged: 'changed' }),
    ).toBe(false);
    expect(
      isFileExplained({ whatItDoes: 'does', whatChanged: '' }),
    ).toBe(false);
  });
});

describe('classifyCategory', () => {
  it('flags files matching test conventions across languages', () => {
    const testPaths = [
      'src/__tests__/login.ts',
      'backend/tests/foo.spec.ts',
      'ui/src/lib/api.test.ts',
      'ui/src/lib/api.spec.tsx',
      'server/PoolAllocatorTests.cs',
      'server/RgServerEventsTest.cs',
      'pkg/handler_test.go',
      'app/test_service.py',
      'app/service_test.py',
    ];
    for (const path of testPaths) {
      expect(classifyCategory(path)).toBe('test');
    }
  });

  it('treats production files as code', () => {
    const codePaths = [
      'src/auth/login.ts',
      'server/GlobalSuppressions.cs',
      'pkg/handler.go',
      'app/service.py',
      'ui/src/features/page.tsx',
    ];
    for (const path of codePaths) {
      expect(classifyCategory(path)).toBe('code');
    }
  });
});
