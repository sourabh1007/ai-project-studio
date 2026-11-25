import { StrictMode, useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopLifecycle } from './desktop-lifecycle.js';
import { useAsync } from '../hooks/use-async.js';
import { ViewSkeleton } from '../components/view-skeleton.js';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, 'fullscreenElement');
  vi.unstubAllGlobals();
});
function paint() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}
function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Panel({ load, children }: { load: () => Promise<string>; children?: React.ReactNode }) {
  const result = useAsync(load, []);
  return result.loading ? <ViewSkeleton /> : result.error
    ? <p role="alert">{result.error}</p> : <div>{result.data}{children}</div>;
}

describe('desktop lifecycle', () => {
  it('reveals only after cascading initial requests settle and paint, once even in StrictMode', async () => {
    const ready = vi.fn();
    vi.stubGlobal('desktop', { ready });
    const first = deferred();
    const second = deferred();
    render(<StrictMode><DesktopLifecycle>
      <Panel load={() => first.promise}><Panel load={() => second.promise} /></Panel>
    </DesktopLifecycle></StrictMode>);
    paint(); paint();
    expect(ready).not.toHaveBeenCalled();
    await act(async () => first.resolve('Workspace'));
    paint(); paint();
    expect(ready).not.toHaveBeenCalled();
    await act(async () => second.resolve('Restored terminal'));
    paint();
    expect(ready).not.toHaveBeenCalled();
    paint();
    expect(screen.getByText('Restored terminal')).toBeInTheDocument();
    expect(ready).toHaveBeenCalledTimes(1);
    paint(); paint();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('reveals actionable request failures rather than hiding behind the splash forever', async () => {
    const ready = vi.fn();
    vi.stubGlobal('desktop', { ready });
    const request = deferred();
    render(<DesktopLifecycle><Panel load={() => request.promise} /></DesktopLifecycle>);
    await act(async () => request.reject(new Error('Retry workspace loading')));
    paint(); paint();
    expect(screen.getByRole('alert')).toHaveTextContent('Retry workspace loading');
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('keeps content mounted under a blocking, fullscreen-aware closing animation and recovers on cancellation', () => {
    let update!: (state: 'closing' | 'running') => void;
    const unsubscribe = vi.fn();
    vi.stubGlobal('desktop', { onLifecycleState: (callback: typeof update) => {
      update = callback;
      return unsubscribe;
    } });
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Content() {
      useEffect(() => { mounted(); return unmounted; }, []);
      return <button>Saved workspace</button>;
    }
    const fullscreen = document.createElement('div');
    document.body.append(fullscreen);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: fullscreen });
    const view = render(<DesktopLifecycle><Content /></DesktopLifecycle>);
    act(() => update('closing'));
    const dialog = screen.getByRole('dialog', { name: 'Closing AI Project Studio' });
    expect(fullscreen).toContainElement(dialog);
    expect(screen.getByRole('progressbar', { name: 'Closing Studio' })).not.toHaveAttribute('aria-valuenow');
    expect(screen.getByRole('status')).toHaveTextContent('stopping local services safely');
    expect(screen.getByRole('status')).toHaveTextContent('Studio will close when shutdown is confirmed.');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(dialog).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
    act(() => update('running'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saved workspace' })).toBeInTheDocument();
    expect(unmounted).not.toHaveBeenCalled();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    fullscreen.remove();
    vi.restoreAllMocks();
  });

  it('preserves browser behavior without a desktop bridge and cancels pending reveal on unmount', () => {
    vi.stubGlobal('desktop', undefined);
    const view = render(<DesktopLifecycle>Browser workspace</DesktopLifecycle>);
    paint(); paint();
    expect(screen.getByText('Browser workspace')).toBeInTheDocument();
    view.unmount();
    const ready = vi.fn();
    vi.stubGlobal('desktop', { ready });
    const next = render(<DesktopLifecycle>Desktop workspace</DesktopLifecycle>);
    paint();
    next.unmount();
    paint();
    expect(ready).not.toHaveBeenCalled();
  });
});
