import { describe, expect, it } from 'vitest';
import { classifyStatus } from './status.js';

describe('classifyStatus', () => {
  it('maps every running synonym to the animated accent tone', () => {
    for (const raw of [
      'running',
      'Active',
      'generating',
      'in progress',
      'in_progress',
      'IN-PROGRESS',
      'working',
      'busy',
      'processing',
      'loading',
      'starting',
      'live',
    ]) {
      const d = classifyStatus(raw);
      expect(d.tone).toBe('running');
      expect(d.animated).toBe(true);
      expect(d.glyph).toBe('spinner');
      expect(d.label).toBe('Running');
    }
  });

  it('maps success synonyms (done/ready/finished/succeeded) to one tone', () => {
    for (const raw of [
      'completed',
      'complete',
      'done',
      'ready',
      'finished',
      'succeeded',
      'success',
      'passed',
      'ok',
      'healthy',
      'connected',
      'up to date',
      'uptodate',
    ]) {
      const d = classifyStatus(raw);
      expect(d.tone).toBe('success');
      expect(d.glyph).toBe('check');
      expect(d.animated).toBe(false);
    }
  });

  it('maps failure synonyms to the red cross tone', () => {
    for (const raw of ['failed', 'failure', 'error', 'errored', 'broken', 'crashed']) {
      expect(classifyStatus(raw).tone).toBe('failed');
      expect(classifyStatus(raw).glyph).toBe('cross');
    }
  });

  it('classifies warning, pending, paused and disabled families', () => {
    expect(classifyStatus('degraded').tone).toBe('warning');
    expect(classifyStatus('warn').glyph).toBe('warn');
    expect(classifyStatus('queued').tone).toBe('pending');
    expect(classifyStatus('checking').tone).toBe('pending');
    expect(classifyStatus('idle').tone).toBe('paused');
    expect(classifyStatus('cancelled').tone).toBe('paused');
    expect(classifyStatus('paused').glyph).toBe('pause');
    expect(classifyStatus('disabled').tone).toBe('disabled');
    expect(classifyStatus('unavailable').tone).toBe('disabled');
  });

  it('falls back to a neutral, Title-Cased label for unknown values', () => {
    const d = classifyStatus('needs_review');
    expect(d.tone).toBe('neutral');
    expect(d.glyph).toBe('circle');
    expect(d.label).toBe('Needs Review');
  });

  it('handles empty/whitespace input without throwing', () => {
    const d = classifyStatus('   ');
    expect(d.tone).toBe('neutral');
    expect(d.label).toBe('Unknown');
  });
});
