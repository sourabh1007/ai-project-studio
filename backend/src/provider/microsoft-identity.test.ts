import { describe, expect, it, vi } from 'vitest';
import { createMicrosoftIdentity } from './microsoft-identity.js';

describe('createMicrosoftIdentity', () => {
  it('defaults to signed out', () => {
    expect(createMicrosoftIdentity().isSignedIn()).toBe(false);
  });

  it('honours an explicit initial state', () => {
    expect(createMicrosoftIdentity(true).isSignedIn()).toBe(true);
  });

  it('updates state and notifies listeners only on a real change', () => {
    const identity = createMicrosoftIdentity(false);
    const listener = vi.fn();
    identity.onChange(listener);

    identity.set(false);
    expect(listener).not.toHaveBeenCalled();
    expect(identity.isSignedIn()).toBe(false);

    identity.set(true);
    expect(identity.isSignedIn()).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(true);

    identity.set(true);
    expect(listener).toHaveBeenCalledOnce();

    identity.set(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('keeps an authenticated organization when a different organization requires sign-in', () => {
    const identity = createMicrosoftIdentity();
    const listener = vi.fn();
    identity.onChange(listener);
    identity.set(true, 'org-a');
    identity.set(false, 'org-b');
    identity.set(true, 'org-c');
    identity.set(false, 'org-a');
    expect(identity.isSignedIn()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    identity.set(false, 'org-c');
    expect(identity.isSignedIn()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
    identity.set(true, 'org-a');
    identity.set(false);
    expect(identity.isSignedIn()).toBe(false);
    identity.set(false, 'org-b');
    expect(identity.isSignedIn()).toBe(false);
  });
});
