import { useEffect, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Button, ErrorText } from '../../components/ui.js';
import { providerLabel } from '../../lib/meta-model.js';
import type { ProviderSelectionInfo } from '../../lib/api.js';
import { ProviderInstallGate } from '../bootstrap/provider-install-gate.js';
import { CliSelector } from '../bootstrap/cli-selector.js';
import { AutomationReadinessNotice } from '../../app/automation-readiness.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { CLI_SHORTCUT_CHANGED, CLI_SHORTCUT_KEY, PROVIDER_PREFERENCES_CHANGED, isCliShortcut, type CliShortcut } from '../../lib/provider-selection.js';

export function CliSection({ onProviders, onConfigChanged }: { onProviders?: (ids: string[]) => void; onConfigChanged?: () => void }) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(() => api.getProviderBootstrap(), []);
  const [selected, setSelected] = useState<ProviderSelectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [shortcut, setShortcut] = usePersistentState<CliShortcut>(CLI_SHORTCUT_KEY, 'l', { validate: isCliShortcut });
  const info = selected ?? (error ? null : data);
  useEffect(() => {
    onProviders?.(info?.providers.map((provider) => provider.configNamespace ?? provider.id) ?? []);
  }, [info, onProviders]);

  async function stopIdle() {
    setBusy(true);
    setFailure(null);
    try {
      await api.stopIdleProviderWorkers();
      setSelected(await api.getProviderBootstrap());
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function setInternalAgency(enabled: boolean) {
    setBusy(true);
    setFailure(null);
    try {
      const updated = await api.updateProviderPreferences({ allowInternalAgency: enabled });
      setSelected(updated);
      window.dispatchEvent(new CustomEvent(PROVIDER_PREFERENCES_CHANGED, { detail: updated }));
      onConfigChanged?.();
    } catch (cause: unknown) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="CLI selection">
      <h2 className="page-title">CLI</h2>
      <p>Only one CLI is active globally. Switching asks permission to stop interactive work, waits for confirmed exit, and preserves every provider’s history.</p>
      <p>Agency is optional and Microsoft-internal only. Copilot and Claude work without it. Opt-in is operator attestation, not verified employment or entitlement; Microsoft sign-in and network access never enable it. Agency enforces its own authentication.</p>
      <AutomationReadinessNotice />
      <label className="field">
        <span><input type="checkbox" aria-label="I am an authorized Microsoft-internal Agency user"
          checked={info?.internalAgencyEnabled ?? false} disabled={busy || loading || !info}
          onChange={(event) => void setInternalAgency(event.target.checked)} /> I am an authorized Microsoft-internal Agency user</span>
        <span className="field-hint">Only enable this for an authorized, installed Agency CLI. No internal credentials are provided. This does not select, install or launch Agency.</span>
      </label>
      <label className="field">
        <span>CLI picker keyboard shortcut</span>
        <select value={shortcut} onChange={(event) => {
          const value = event.target.value;
          if (!isCliShortcut(value)) return;
          setShortcut(value);
          window.dispatchEvent(new CustomEvent(CLI_SHORTCUT_CHANGED, { detail: value }));
        }}>
          <option value="l">Ctrl/Cmd+Shift+L</option>
          <option value="y">Ctrl/Cmd+Shift+Y</option>
          <option value="off">Disabled</option>
        </select>
      </label>
      {loading && <p role="status">Checking installed CLIs…</p>}
      <ErrorText error={error} />
      <Button variant="secondary" disabled={busy || loading} onClick={() => { setSelected(null); reload(); }}>Refresh CLI status</Button>
      <ErrorText error={failure} />
      {info && (
        <>
          <p>Active CLI: <strong>{info.selectionRequired ? 'Not selected' : providerLabel(info.defaultProvider)}</strong></p>
          <p>Remember me: {(info.remember ?? !info.selectionRequired) ? 'On' : 'Off — choose again on restart'}</p>
          {info.blockers?.map((blocker) => <p key={`${blocker.kind}:${blocker.id}`}>Stop {blocker.label} before switching.</p>)}
          {Boolean(info.blockers?.length) && info.blockers?.every((blocker) => /warm|probe|pool/i.test(blocker.kind)) && (
            <Button disabled={busy} onClick={() => void stopIdle()}>Stop idle background CLI workers</Button>
          )}
          {info.providers.map((provider) => (
            <div key={provider.id} className="config-namespace">
              <h3>{provider.label ?? providerLabel(provider.id)}</h3>
              <p>{provider.installed ? 'Installed' : 'Not installed'}</p>
              {provider.automation?.supported === false && <p role="status">Interactive use only — automated AI is unavailable. {provider.automation.reason} Choose another CLI for agents and AI planning.</p>}
              {!provider.automation && <p>Automation readiness is unreported. Refresh CLI status or update the backend before using agents and AI planning.</p>}
              {provider.installCommand && <p>Install command: <code>{provider.installCommand}</code></p>}
              {provider.installAvailable === false && !provider.installed && <p>Automatic installation unavailable.</p>}
              <Button
                disabled={busy || loading || !provider.installed}
                onClick={() => setPicker(provider.id)}
              >
                Use {provider.label ?? providerLabel(provider.id)}
              </Button>
            </div>
          ))}
          {info.providers.some((p) => !p.installed) && (
            <Button variant="secondary" onClick={() => setSetup(true)}>Open CLI setup</Button>
          )}
        </>
      )}
      {setup && <ProviderInstallGate forceChoose><p role="status">CLI setup closed. Refresh CLI status to confirm installation.</p></ProviderInstallGate>}
      {picker && <CliSelector initialProviderId={picker} onClose={() => {
        setPicker(null);
        setSelected(null);
        reload();
      }} />}
    </section>
  );
}
