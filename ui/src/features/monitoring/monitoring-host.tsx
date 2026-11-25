import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../../app/api-context.js';
import type { LiveState } from '../../lib/stream.js';
import type { PoppableTab } from '../workspace/tab-popout.js';

type Owner = { featureId: string } & ({ sessionId: string } | { attachmentId: string; agentId: string });
interface MonitoringHost {
  live: LiveState;
  visibility: { visible: boolean; revision: number };
  openOwner?: (owner: Owner) => Promise<void>;
  openCapacity?: () => void;
}
const Context = createContext<MonitoringHost | null>(null);
export const useMonitoringHost = () => useContext(Context);

export function MonitoringProvider({ live, children, onOpen, onCapacity, navigationKey }: {
  live: LiveState; children: ReactNode; onOpen?: (tab: PoppableTab) => void; onCapacity?: () => void; navigationKey?: string;
}) {
  const api = useApi();
  const request = useRef(0);
  const [visibility, setVisibility] = useState({ visible: document.visibilityState !== 'hidden', revision: 0 });
  useEffect(() => {
    const changed = () => setVisibility((previous) => ({ visible: document.visibilityState !== 'hidden', revision: previous.revision + 1 }));
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => { request.current += 1; return () => { request.current += 1; }; }, [navigationKey]);
  async function openOwner(owner: Owner) {
    const token = ++request.current;
    let tab: PoppableTab;
    if ('sessionId' in owner) {
      const session = await api.getSession(owner.sessionId);
      if (session.id !== owner.sessionId || session.featureId !== owner.featureId || session.scope === 'internal' || session.kind === 'meta')
        throw new Error('The originating workspace session is no longer available.');
      tab = { kind: 'session', id: session.id, label: session.name ?? 'Session', session };
    } else {
      const [feature, attached] = await Promise.all([api.getFeature(owner.featureId), api.listFeatureAgents(owner.featureId)]);
      const match = attached.find(({ attachment, manifest }) => attachment.id === owner.attachmentId &&
        attachment.featureId === owner.featureId && attachment.agentId === owner.agentId && manifest.id === owner.agentId);
      if (!match || feature.id !== owner.featureId) throw new Error('The owning agent is no longer attached. No replacement was created.');
      tab = { kind: 'agent', id: match.manifest.allowMultiplePerFeature ? `agent:${match.attachment.id}` : `agent:${match.manifest.id}:${feature.id}`,
        label: `${match.manifest.title} · ${feature.name}`, agentId: match.manifest.id, attachmentId: match.attachment.id, feature };
    }
    if (token === request.current) onOpen?.(tab);
  }
  return <Context.Provider value={{ live, visibility, openOwner: onOpen ? openOwner : undefined, openCapacity: onCapacity }}>{children}</Context.Provider>;
}
