import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi } from './api-context.js';
import type { ProviderSelectionInfo } from '../lib/api.js';
import type { ProviderAutomationReadiness } from '../lib/types.js';
import { PROVIDER_CHANGED } from '../lib/provider-selection.js';
import { CliSelector } from '../features/bootstrap/cli-selector.js';
import { Button } from '../components/ui.js';
import { ClockIcon, WarningIcon } from '../components/icons.js';
import { ProviderFeatureChecklist } from '../components/provider-feature-checklist.js';
import { useUnavailableFeatures } from '../hooks/use-unavailable-features.js';
import type { ProviderFeatureSource } from '../lib/provider-features.js';

interface AutomationReadiness extends ProviderAutomationReadiness {
  refresh(): void;
  choose(): void;
  showUnavailableFeatures: boolean;
  canAttempt: boolean;
  provider: ProviderFeatureSource | null;
}

// Standalone hosts may omit this advisory surface; backend launch policy is
// always authoritative. The mounted app and detached windows supply it.
const ReadinessContext = createContext<AutomationReadiness | null>(null);
export const useAutomationReadiness = () => useContext(ReadinessContext);

export function AutomationReadinessProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [info, setInfo] = useState<ProviderSelectionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [picker, setPicker] = useState(false);
  const [showUnavailableFeatures] = useUnavailableFeatures();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      active = false;
      setLoading(false);
      setError('Automation readiness could not be confirmed in time. Refresh readiness or choose another CLI.');
    }, 20_000);
    void api.getProviderBootstrap().then((result) => {
      if (active) { setInfo(result); setLoading(false); clearTimeout(timer); }
    }).catch((failure: unknown) => {
      if (active) {
        setError(`Automation readiness is unknown: ${failure instanceof Error ? failure.message : String(failure)}. Refresh readiness or choose another CLI.`);
        setLoading(false);
        clearTimeout(timer);
      }
    });
    const changed = (event: Event) => {
      active = false;
      clearTimeout(timer);
      setInfo((event as CustomEvent<ProviderSelectionInfo>).detail);
      setError(null);
      setLoading(false);
    };
    window.addEventListener(PROVIDER_CHANGED, changed);
    return () => { active = false; clearTimeout(timer); window.removeEventListener(PROVIDER_CHANGED, changed); };
  }, [api, attempt]);
  const provider = info?.providers.find((entry) => entry.id === info.defaultProvider);
  const capability: ProviderAutomationReadiness = loading
    ? { supported: false, state: 'checking', reason: 'Checking automation readiness. Interactive CLI sessions remain available.' }
    : error ? { supported: false, reason: error }
      : !provider || info?.selectionRequired || !provider.installed
        ? { supported: false, reason: 'Choose an installed active CLI before starting automated AI work.' }
        : typeof provider.automation?.supported === 'boolean'
          ? { ...provider.automation, supported: provider.automation.supported, reason: typeof provider.automation.reason === 'string' ? provider.automation.reason : null }
          : { supported: false, reason: 'This backend did not report valid automation readiness. Refresh readiness or update the backend before starting automated AI work.' };
  return <ReadinessContext.Provider value={{
    ...capability, showUnavailableFeatures, canAttempt: capability.supported || showUnavailableFeatures,
    provider: !loading && !error && provider
      ? { installed: provider.installed === true, automation: capability, features: provider.features }
      : null,
    refresh: () => setAttempt((value) => value + 1), choose: () => setPicker(true),
  }}>
    {children}
    {picker && <CliSelector onClose={() => { setPicker(false); setAttempt((value) => value + 1); }} />}
  </ReadinessContext.Provider>;
}

export function AutomationReadinessNotice() {
  const readiness = useAutomationReadiness();
  if (!readiness || readiness.supported) return null;
  const checking = readiness.state === 'checking';
  return <section className="automation-readiness-notice" aria-label="Automation unavailable">
    <div className="automation-readiness-heading">
      {checking ? <ClockIcon size={18} /> : <WarningIcon size={18} />}
      <strong>{checking ? 'Checking AI readiness' : 'AI automation is not ready'}</strong>
    </div>
    <p role="status">{readiness.reason}</p>
    <div className="automation-readiness-actions">
      <Button variant="secondary" onClick={readiness.refresh}>Refresh automation readiness</Button>
      <Button variant="ghost" onClick={readiness.choose}>Choose another CLI</Button>
    </div>
    {readiness.provider && <ProviderFeatureChecklist provider={readiness.provider} hideHelp />}
  </section>;
}

export function AutomationBoundary({ children }: { children: ReactNode }) {
  const readiness = useAutomationReadiness();
  return readiness && !readiness.supported
    ? <><AutomationReadinessNotice />{readiness.showUnavailableFeatures && children}</>
    : <>{children}</>;
}
