import { describe, it, expect } from 'vitest';
import {
  isMultiline,
  controlKindFor,
  seedValue,
  parseInput,
  sameValue,
  buildFields,
  matchesQuery,
  buildConfigTabs,
  fieldLabel,
  fieldHelp,
  type SettingField,
  type ControlKind,
} from './settings-model.js';
import type { ConfigValue, FieldMeta } from './types.js';

describe('isMultiline', () => {
  it('is true for newlines or long strings', () => {
    expect(isMultiline('a\nb')).toBe(true);
    expect(isMultiline('x'.repeat(61))).toBe(true);
  });
  it('is false for short single-line strings', () => {
    expect(isMultiline('short')).toBe(false);
  });
});

describe('controlKindFor', () => {
  it('derives the control from schema metadata', () => {
    expect(controlKindFor({ kind: 'boolean' }, true)).toBe('boolean');
    expect(controlKindFor({ kind: 'number' }, 1)).toBe('number');
    expect(controlKindFor({ kind: 'enum', options: ['a'] }, 'a')).toBe('enum');
    expect(controlKindFor({ kind: 'string' }, 'hi')).toBe('text');
    expect(controlKindFor({ kind: 'string' }, 'a\nb')).toBe('multiline');
    // A string field whose value is not a string still renders as text.
    expect(controlKindFor({ kind: 'string' }, 5)).toBe('text');
    expect(controlKindFor({ kind: 'array', element: { kind: 'string' } }, [])).toBe(
      'json',
    );
    expect(controlKindFor({ kind: 'object', fields: {} }, {})).toBe('json');
    expect(controlKindFor({ kind: 'unknown' }, null)).toBe('json');
  });

  it('falls back to the runtime value type without metadata', () => {
    expect(controlKindFor(undefined, true)).toBe('boolean');
    expect(controlKindFor(undefined, 42)).toBe('number');
    expect(controlKindFor(undefined, 'plain')).toBe('text');
    expect(controlKindFor(undefined, 'line\nline')).toBe('multiline');
    expect(controlKindFor(undefined, { a: 1 })).toBe('json');
  });
});

describe('seedValue', () => {
  it('seeds each control from its value', () => {
    expect(seedValue(true, 'boolean')).toBe(true);
    expect(seedValue({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}');
    expect(seedValue('hi', 'text')).toBe('hi');
    expect(seedValue('a\nb', 'multiline')).toBe('a\nb');
    expect(seedValue('opt', 'enum')).toBe('opt');
    expect(seedValue(7, 'number')).toBe('7');
  });
  it('seeds nullish text-like values as an empty string', () => {
    expect(seedValue(null, 'text')).toBe('');
    expect(seedValue(undefined, 'enum')).toBe('');
  });
});

describe('parseInput', () => {
  it('returns booleans as-is', () => {
    expect(parseInput(true, 'boolean')).toBe(true);
  });

  it('parses numbers and enforces bounds and integer-only', () => {
    expect(parseInput('3', 'number')).toBe(3);
    expect(() => parseInput('', 'number')).toThrow('valid number');
    expect(() => parseInput('nope', 'number')).toThrow('valid number');
    expect(() =>
      parseInput('1.5', 'number', { kind: 'number', int: true }),
    ).toThrow('whole number');
    expect(() =>
      parseInput('0', 'number', { kind: 'number', min: 1 }),
    ).toThrow('at least 1');
    expect(() =>
      parseInput('99', 'number', { kind: 'number', max: 10 }),
    ).toThrow('at most 10');
    expect(parseInput('5', 'number', { kind: 'number', min: 1, max: 10, int: true })).toBe(
      5,
    );
  });

  it('parses JSON', () => {
    expect(parseInput('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(() => parseInput('{bad', 'json')).toThrow();
  });

  it('validates enum membership when options are known', () => {
    const meta: FieldMeta = { kind: 'enum', options: ['a', 'b'] };
    expect(parseInput('a', 'enum', meta)).toBe('a');
    expect(() => parseInput('c', 'enum', meta)).toThrow('allowed values');
    // Without options metadata, any value passes through.
    expect(parseInput('anything', 'enum')).toBe('anything');
  });

  it('returns text/multiline strings unchanged', () => {
    expect(parseInput('hello', 'text')).toBe('hello');
    expect(parseInput('a\nb', 'multiline')).toBe('a\nb');
  });
});

describe('sameValue', () => {
  it('detects equal and changed values', () => {
    expect(sameValue('3', 3, 'number')).toBe(true);
    expect(sameValue('4', 3, 'number')).toBe(false);
    expect(sameValue(true, true, 'boolean')).toBe(true);
  });
  it('treats invalid input as changed', () => {
    expect(sameValue('nope', 3, 'number')).toBe(false);
  });
});

describe('buildFields', () => {
  it('builds fields pairing values with their metadata', () => {
    const fields = buildFields(
      { enabled: true, name: 'x' },
      { enabled: { kind: 'boolean' }, name: { kind: 'string' } },
    );
    expect(fields).toEqual([
      { key: 'enabled', value: true, meta: { kind: 'boolean' }, control: 'boolean' },
      { key: 'name', value: 'x', meta: { kind: 'string' }, control: 'text' },
    ]);
  });
  it('works without any metadata', () => {
    const fields = buildFields({ n: 1 }, undefined);
    expect(fields).toEqual([
      { key: 'n', value: 1, meta: undefined, control: 'number' },
    ]);
  });
});

describe('matchesQuery', () => {
  it('matches everything on an empty term', () => {
    expect(matchesQuery('logging', 'level', '')).toBe(true);
  });
  it('matches on the dotted path', () => {
    expect(matchesQuery('logging', 'level', 'log')).toBe(true);
    expect(matchesQuery('logging', 'level', 'lev')).toBe(true);
    expect(matchesQuery('logging', 'level', 'nope')).toBe(false);
  });
});

describe('buildConfigTabs', () => {
  it('groups namespaces into curated, ordered, non-empty tabs', () => {
    const tabs = buildConfigTabs(['meta', 'session', 'logging', 'usage']);
    expect(tabs.map((t) => t.id)).toEqual(['ai', 'workspace', 'usage', 'system']);
    expect(tabs[0]).toEqual({ id: 'ai', label: 'AI & Automation', namespaces: ['meta'] });
  });

  it('collects unknown namespaces into an Other tab', () => {
    const tabs = buildConfigTabs(['meta', 'brand-new-module']);
    expect(tabs.map((t) => t.id)).toEqual(['ai', 'other']);
    expect(tabs[1]).toEqual({
      id: 'other',
      label: 'Other',
      namespaces: ['brand-new-module'],
    });
  });

  it('returns no tabs for no namespaces', () => {
    expect(buildConfigTabs([])).toEqual([]);
  });
});

describe('fieldLabel', () => {
  it('humanizes camelCase keys with acronyms and units', () => {
    expect(fieldLabel('providerId')).toBe('Provider ID');
    expect(fieldLabel('responseTextKeys')).toBe('Response Text Keys');
    expect(fieldLabel('timeoutMs')).toBe('Timeout (ms)');
    expect(fieldLabel('model')).toBe('Model');
    expect(fieldLabel('warmPool')).toBe('Warm Pool');
  });

  it('splits snake_case and kebab-case', () => {
    expect(fieldLabel('response_text_keys')).toBe('Response Text Keys');
    expect(fieldLabel('warm-pool')).toBe('Warm Pool');
  });

  it('handles acronym-to-word boundaries', () => {
    expect(fieldLabel('httpUrl')).toBe('HTTP URL');
    expect(fieldLabel('HTTPServer')).toBe('HTTP Server');
  });

  it('returns the raw key when there are no word characters', () => {
    expect(fieldLabel('')).toBe('');
    expect(fieldLabel('__')).toBe('__');
  });
});

describe('fieldHelp', () => {
  function field(
    control: ControlKind,
    meta?: FieldMeta,
    value: ConfigValue = null,
  ): SettingField {
    return { key: 'k', control, meta, value };
  }

  it('prefers the schema description when present', () => {
    expect(
      fieldHelp(field('text', { kind: 'string', description: 'The model id.' })),
    ).toBe('The model id.');
  });

  it('describes booleans', () => {
    expect(fieldHelp(field('boolean', { kind: 'boolean' }))).toBe(
      'On/off toggle.',
    );
  });

  it('describes numbers with bounds and integer flag', () => {
    expect(
      fieldHelp(field('number', { kind: 'number', int: true, min: 0, max: 10 })),
    ).toBe('Whole number. Between 0 and 10.');
    expect(fieldHelp(field('number', { kind: 'number', min: 1 }))).toBe(
      'Numeric value. At least 1.',
    );
    expect(fieldHelp(field('number', { kind: 'number', max: 5 }))).toBe(
      'Numeric value. At most 5.',
    );
    expect(fieldHelp(field('number', { kind: 'number' }))).toBe('Numeric value.');
  });

  it('describes enums with and without options', () => {
    expect(
      fieldHelp(field('enum', { kind: 'enum', options: ['a', 'b'] })),
    ).toBe('One of: a, b.');
    expect(fieldHelp(field('enum', { kind: 'enum', options: [] }))).toBe(
      'Choose a value.',
    );
    expect(fieldHelp(field('enum', { kind: 'enum' }))).toBe('Choose a value.');
  });

  it('describes text and multiline with length constraints', () => {
    expect(
      fieldHelp(field('text', { kind: 'string', minLength: 1, maxLength: 5 })),
    ).toBe('Text value. 1–5 characters.');
    expect(fieldHelp(field('text', { kind: 'string', minLength: 2 }))).toBe(
      'Text value. At least 2 characters.',
    );
    expect(
      fieldHelp(field('multiline', { kind: 'string', maxLength: 10 })),
    ).toBe('Text value. Up to 10 characters.');
    expect(fieldHelp(field('text', { kind: 'string' }))).toBe('Text value.');
  });

  it('describes JSON arrays and objects', () => {
    expect(
      fieldHelp(field('json', { kind: 'array', element: { kind: 'string' } }, [])),
    ).toBe('Editable list (JSON).');
    expect(fieldHelp(field('json', { kind: 'object', fields: {} }, {}))).toBe(
      'Structured value (JSON).',
    );
  });

  it('appends default, optional and nullable notes', () => {
    expect(
      fieldHelp(
        field('text', { kind: 'string', default: 'agency', optional: true }),
      ),
    ).toBe('Text value. Default: agency. Optional.');
    expect(
      fieldHelp(field('number', { kind: 'number', default: 300000 })),
    ).toBe('Numeric value. Default: 300000.');
    expect(
      fieldHelp(field('json', { kind: 'object', nullable: true }, null)),
    ).toBe('Structured value (JSON). May be null.');
  });

  it('truncates long default values', () => {
    const help = fieldHelp(
      field('json', { kind: 'array', default: ['x'.repeat(60)] }, []),
    );
    expect(help).toContain('Default: ');
    expect(help).toContain('…');
    expect(help.length).toBeLessThan(80);
  });

  it('generates help without metadata', () => {
    expect(fieldHelp(field('boolean'))).toBe('On/off toggle.');
  });
});
