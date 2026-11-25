import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { desktopBridge } from '../lib/desktop-bridge.js';
import { Modal } from '../components/ui.js';
import { ClockIcon, PowerIcon } from '../components/icons.js';

const StartupContext = createContext<(() => () => void) | undefined>(undefined);

/** Keep the native splash until the first view and its initial requests settle. */
export function useStartupPending(pending: boolean) {
  const register = useContext(StartupContext);
  useLayoutEffect(() => pending ? register?.() : undefined, [pending, register]);
}

export function DesktopLifecycle({ children }: { children: ReactNode }) {
  const tasks = useRef(new Set<symbol>());
  const mounted = useRef(false);
  const ready = useRef(false);
  const frame = useRef(0);
  const [closing, setClosing] = useState(false);
  const checkReady = useCallback(() => {
    cancelAnimationFrame(frame.current);
    if (!mounted.current || ready.current || tasks.current.size > 0 || !desktopBridge()?.ready) return;
    // Let cascading requests and lazy views commit before revealing the window.
    frame.current = requestAnimationFrame(() => {
      frame.current = requestAnimationFrame(() => {
        if (!mounted.current || tasks.current.size > 0 || ready.current) return;
        ready.current = true;
        desktopBridge()?.ready?.();
      });
    });
  }, []);
  const register = useCallback(() => {
    if (ready.current) return () => {};
    const task = Symbol();
    tasks.current.add(task);
    checkReady();
    return () => {
      tasks.current.delete(task);
      checkReady();
    };
  }, [checkReady]);

  useLayoutEffect(() => {
    mounted.current = true;
    checkReady();
    return () => {
      mounted.current = false;
      cancelAnimationFrame(frame.current);
    };
  }, [checkReady]);
  useEffect(() => desktopBridge()?.onLifecycleState?.((state) => setClosing(state === 'closing')), []);

  return <StartupContext.Provider value={register}>
    {children}
    {closing && <Modal title="Closing AI Project Studio" dismissible={false}
      className="desktop-lifecycle-dialog" onClose={() => {}}>
      <div className="desktop-lifecycle-scene" aria-hidden="true">
        <span className="desktop-lifecycle-orbit" />
        <span className="desktop-lifecycle-core"><PowerIcon size={28} /></span>
      </div>
      <div className="desktop-lifecycle-copy">
        <span className="desktop-lifecycle-kicker">Until next session</span>
        <h3>Good work. Let's wrap up.</h3>
        <p role="status">Finishing up and stopping local services safely. Studio will close when shutdown is confirmed.</p>
      </div>
      <div className="desktop-lifecycle-bar" role="progressbar" aria-label="Closing Studio">
        <span />
      </div>
      <p className="desktop-lifecycle-hint"><ClockIcon size={13} /> Background work may need a moment to finish.</p>
    </Modal>}
  </StartupContext.Provider>;
}
