import { describe, it, expect, vi } from 'vitest';
import { createSessionFileTracker } from './session-file-tracker.js';
import type {
  DirectoryChange,
  DirectoryWatcherFactory,
  SessionFilesStore,
} from './session-files-contract.js';

function fakeStore() {
  const records: Array<{
    sessionId: string;
    path: string;
    tool: string;
    at: string;
  }> = [];
  const store: SessionFilesStore = {
    record: (sessionId, path, tool, at) =>
      records.push({ sessionId, path, tool, at }),
    list: () => [],
    deleteBySession: () => {},
  };
  return { store, records };
}

function fakeWatchers() {
  const emitters = new Map<string, (change: DirectoryChange) => void>();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  let created = 0;
  const factory: DirectoryWatcherFactory = (root, onChange) => {
    created += 1;
    emitters.set(root, onChange);
    const close = vi.fn();
    closes.set(root, close);
    return { close };
  };
  return {
    factory,
    emit: (root: string, change: DirectoryChange) => emitters.get(root)!(change),
    close: (root: string) => closes.get(root)!,
    get created() {
      return created;
    },
  };
}

function build(ignore: (p: string) => boolean = () => false) {
  const { store, records } = fakeStore();
  const watchers = fakeWatchers();
  let clock = 0;
  const tracker = createSessionFileTracker({
    store,
    watcherFactory: watchers.factory,
    now: () => `t${(clock += 1)}`,
    ignore,
  });
  return { tracker, records, watchers };
}

describe('createSessionFileTracker', () => {
  it('records adds as create and changes as edit for the open session', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root');
    watchers.emit('/root', { path: '/root/a.ts', kind: 'add' });
    watchers.emit('/root', { path: '/root/a.ts', kind: 'change' });
    expect(records).toEqual([
      { sessionId: 's1', path: '/root/a.ts', tool: 'create', at: 't1' },
      { sessionId: 's1', path: '/root/a.ts', tool: 'edit', at: 't2' },
    ]);
  });

  it('drops ignored paths', () => {
    const { tracker, records, watchers } = build((p) => p.includes('node_modules'));
    tracker.open('s1', '/root');
    watchers.emit('/root', { path: '/root/node_modules/x.js', kind: 'add' });
    expect(records).toEqual([]);
  });

  it('shares one watcher per root and attributes to the most recently opened session', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root');
    tracker.open('s2', '/root');
    expect(watchers.created).toBe(1);
    watchers.emit('/root', { path: '/root/a.ts', kind: 'add' });
    expect(records[0].sessionId).toBe('s2');
  });

  it('markActive promotes a session to own subsequent changes', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root');
    tracker.open('s2', '/root');
    tracker.markActive('s1');
    watchers.emit('/root', { path: '/root/a.ts', kind: 'add' });
    expect(records[0].sessionId).toBe('s1');
    // Promoting the already-front session is a no-op.
    tracker.markActive('s1');
    watchers.emit('/root', { path: '/root/b.ts', kind: 'add' });
    expect(records[1].sessionId).toBe('s1');
  });

  it('markActive for an unknown session is a no-op', () => {
    const { tracker } = build();
    expect(() => tracker.markActive('ghost')).not.toThrow();
  });

  it('re-opening the same session on the same root promotes it without a new watcher', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root');
    tracker.open('s2', '/root');
    tracker.open('s1', '/root');
    expect(watchers.created).toBe(1);
    watchers.emit('/root', { path: '/root/a.ts', kind: 'add' });
    expect(records[0].sessionId).toBe('s1');
  });

  it('re-opening a session on a different root closes the old watcher when it empties', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root-a');
    tracker.open('s1', '/root-b');
    expect(watchers.close('/root-a')).toHaveBeenCalledTimes(1);
    watchers.emit('/root-b', { path: '/root-b/a.ts', kind: 'add' });
    expect(records[0].sessionId).toBe('s1');
  });

  it('keeps the watcher while another session remains, closing it only when the last leaves', () => {
    const { tracker, watchers } = build();
    tracker.open('s1', '/root');
    tracker.open('s2', '/root');
    tracker.close('s1');
    expect(watchers.close('/root')).not.toHaveBeenCalled();
    tracker.close('s2');
    expect(watchers.close('/root')).toHaveBeenCalledTimes(1);
  });

  it('ignores changes that arrive after the last session has closed', () => {
    const { tracker, records, watchers } = build();
    tracker.open('s1', '/root');
    const emit = () =>
      watchers.emit('/root', { path: '/root/a.ts', kind: 'add' });
    tracker.close('s1');
    expect(emit).not.toThrow();
    expect(records).toEqual([]);
  });

  it('closing an unknown session is a no-op', () => {
    const { tracker } = build();
    expect(() => tracker.close('ghost')).not.toThrow();
  });
});
