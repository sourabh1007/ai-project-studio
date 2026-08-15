import { describe, expect, it } from 'vitest';
import {
  classifyCopyCut,
  fieldSelectionText,
  type ClipboardKeyEvent,
} from './clipboard.js';

function evt(over: Partial<ClipboardKeyEvent>): ClipboardKeyEvent {
  return {
    key: 'c',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  };
}

describe('classifyCopyCut', () => {
  it('classifies Ctrl+C and Cmd+C as copy', () => {
    expect(classifyCopyCut(evt({ key: 'c', ctrlKey: true }))).toBe('copy');
    expect(classifyCopyCut(evt({ key: 'C', metaKey: true }))).toBe('copy');
  });

  it('classifies Ctrl+X and Cmd+X as cut', () => {
    expect(classifyCopyCut(evt({ key: 'x', ctrlKey: true }))).toBe('cut');
    expect(classifyCopyCut(evt({ key: 'X', metaKey: true }))).toBe('cut');
  });

  it('ignores the key without a Ctrl/Cmd modifier', () => {
    expect(classifyCopyCut(evt({ key: 'c' }))).toBeNull();
  });

  it('ignores Shift/Alt variants so it never shadows richer chords', () => {
    expect(classifyCopyCut(evt({ key: 'c', ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(classifyCopyCut(evt({ key: 'x', metaKey: true, altKey: true }))).toBeNull();
  });

  it('ignores other keys', () => {
    expect(classifyCopyCut(evt({ key: 'v', ctrlKey: true }))).toBeNull();
    expect(classifyCopyCut(evt({ key: 'a', ctrlKey: true }))).toBeNull();
  });
});

describe('fieldSelectionText', () => {
  it('returns the selected substring', () => {
    expect(
      fieldSelectionText({ value: 'hello world', selectionStart: 0, selectionEnd: 5 }),
    ).toBe('hello');
  });

  it('handles a backwards selection', () => {
    expect(
      fieldSelectionText({ value: 'hello world', selectionStart: 11, selectionEnd: 6 }),
    ).toBe('world');
  });

  it('returns empty string for a collapsed or absent selection', () => {
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: 2, selectionEnd: 2 }),
    ).toBe('');
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: null, selectionEnd: null }),
    ).toBe('');
    expect(
      fieldSelectionText({ value: 'hello', selectionStart: 1, selectionEnd: null }),
    ).toBe('');
  });
});
