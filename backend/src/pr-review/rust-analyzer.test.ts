import { describe, expect, it } from 'vitest';
import { createRustAnalyzer } from './rust-analyzer.js';

const analyzer = createRustAnalyzer();

describe('createRustAnalyzer', () => {
  it('handles .rs files and Cargo manifests', () => {
    expect(analyzer.handles('src/lib.rs')).toBe(true);
    expect(analyzer.handles('src/lib.py')).toBe(false);
    expect(analyzer.projectManifest.test('Cargo.toml')).toBe(true);
  });

  it('declares structs, enums, traits, aliases and functions', () => {
    const content = `
      pub struct Widget { x: i32 }
      enum Color { Red }
      pub trait Draw {}
      type Id = u64;
      pub fn build() {}
    `;
    const decls = analyzer.declarations(content);
    expect(decls.module).toBeNull();
    expect(decls.types.sort()).toEqual(
      ['Color', 'Draw', 'Id', 'Widget', 'build'].sort(),
    );
  });

  it('detects a usage in a function and ignores use-path noise', () => {
    const content = [
      'use crate::widget::Widget;',
      'pub fn build() {',
      '    let w = Widget::new();',
      '}',
    ].join('\n');
    expect(analyzer.references(content, ['Widget'])).toEqual([
      { type: 'Widget', caller: 'build' },
    ]);
  });
});
