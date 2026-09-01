import { describe, it, expect, vi } from 'vitest';
import { createMetaSettings } from './meta-settings.js';

describe('createMetaSettings', () => {
  it('returns a copy of the current settings', () => {
    const settings = createMetaSettings({ providerId: 'agency', model: 'auto' });
    const first = settings.get();
    first.model = 'mutated';
    expect(settings.get()).toEqual({ providerId: 'agency', model: 'auto' });
  });

  it('merges a partial patch and keeps unspecified fields', () => {
    const settings = createMetaSettings({ providerId: 'agency', model: 'auto' });
    expect(settings.set({ model: 'gpt-5' })).toEqual({
      providerId: 'agency',
      model: 'gpt-5',
    });
    expect(settings.set({ providerId: 'copilot' })).toEqual({
      providerId: 'copilot',
      model: 'gpt-5',
    });
  });

  it('notifies listeners only when a value actually changes', () => {
    const settings = createMetaSettings({ providerId: 'agency', model: 'auto' });
    const listener = vi.fn();
    settings.onChange(listener);

    settings.set({ model: 'auto' });
    expect(listener).not.toHaveBeenCalled();

    settings.set({ model: 'gpt-5' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      providerId: 'agency',
      model: 'gpt-5',
    });
  });

  it('notifies every registered listener on change', () => {
    const settings = createMetaSettings({ providerId: 'agency', model: 'auto' });
    const a = vi.fn();
    const b = vi.fn();
    settings.onChange(a);
    settings.onChange(b);
    settings.set({ providerId: 'copilot' });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
