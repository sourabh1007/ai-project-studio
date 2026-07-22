import { describe, it, expect } from 'vitest';
import { deepMerge, mergeSources, envSource } from './config-loader.js';

describe('config-loader', () => {
  describe('deepMerge', () => {
    it('merges nested objects recursively', () => {
      const out = deepMerge(
        { a: { x: 1, y: 2 }, b: 1 },
        { a: { y: 3, z: 4 }, c: 5 },
      );
      expect(out).toEqual({ a: { x: 1, y: 3, z: 4 }, b: 1, c: 5 });
    });

    it('replaces arrays and scalars wholesale', () => {
      const out = deepMerge({ list: [1, 2], v: 'a' }, { list: [9], v: 'b' });
      expect(out).toEqual({ list: [9], v: 'b' });
    });

    it('overrides a scalar with an object and vice versa', () => {
      expect(deepMerge({ a: 1 }, { a: { n: 2 } })).toEqual({ a: { n: 2 } });
      expect(deepMerge({ a: { n: 2 } }, { a: 1 })).toEqual({ a: 1 });
    });
  });

  describe('mergeSources', () => {
    it('applies sources in order with last-wins', () => {
      const merged = mergeSources([
        { origin: 'defaults', data: { a: 1, b: { x: 1 } } },
        { origin: 'file', data: { b: { x: 2, y: 3 } } },
        { origin: 'env', data: { a: 9 } },
      ]);
      expect(merged).toEqual({ a: 9, b: { x: 2, y: 3 } });
    });

    it('returns an empty object for no sources', () => {
      expect(mergeSources([])).toEqual({});
    });
  });

  describe('envSource', () => {
    it('expands prefixed double-underscore keys into nested objects', () => {
      const src = envSource(
        {
          CW__providers__copilot__enabled: 'true',
          CW__credit__strategy: 'provider-cost',
          OTHER: 'ignored',
          CW__: 'ignored-empty-path',
          CW__skip: undefined,
        },
        'CW',
      );
      expect(src.origin).toBe('env');
      expect(src.data).toEqual({
        providers: { copilot: { enabled: true } },
        credit: { strategy: 'provider-cost' },
      });
    });

    it('coerces JSON scalars and keeps plain strings and secret refs', () => {
      const src = envSource(
        {
          P__port: '4321',
          P__flag: 'false',
          P__nothing: 'null',
          P__args: '["-s","--json"]',
          P__name: 'gpt-5.4',
          P__secret: '${TOKEN}',
        },
        'P',
      );
      expect(src.data).toEqual({
        port: 4321,
        flag: false,
        nothing: null,
        args: ['-s', '--json'],
        name: 'gpt-5.4',
        secret: '${TOKEN}',
      });
    });

    it('overwrites a non-object intermediate when a deeper key arrives', () => {
      const src = envSource(
        { P__a: 'scalar', P__a__b: 'deep' },
        'P',
      );
      expect(src.data).toEqual({ a: { b: 'deep' } });
    });

    it('accepts a custom origin label', () => {
      const src = envSource({ P__a: '1' }, 'P', 'process.env');
      expect(src.origin).toBe('process.env');
    });
  });
});
