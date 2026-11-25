import { useEffect, useState, type ReactNode } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import { CheckIcon, ChevronIcon, CloseIcon, InfoIcon, ProviderIcon } from '../../components/icons.js';
import { providerLabel } from '../../lib/meta-model.js';
import type { ProviderSelectionInfo } from '../../lib/api.js';
import { ProviderInstallGate } from '../bootstrap/provider-install-gate.js';
import { CliSelector } from '../bootstrap/cli-selector.js';
import { ProviderFeatureChecklist } from '../../components/provider-feature-checklist.js';
import { useUnavailableFeatures } from '../../hooks/use-unavailable-features.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';
import { CLI_SHORTCUT_CHANGED, CLI_SHORTCUT_KEY, isCliShortcut, type CliShortcut } from '../../lib/provider-selection.js';

type CliProvider = ProviderSelectionInfo['providers'][number];

export function CliSection({ onProviders, renderProviderSettings }: {
  onProviders?: (ids: string[]) => void;
  onConfigChanged?: () => void;
  renderProviderSettings?: (provider: CliProvider) => ReactNode;
}) {
  const api = useApi();
  const { data, loading, error, reload } = useAsync(() => api.getProviderBootstrap(), []);
  const [selected, setSelected] = useState<ProviderSelectionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [picker, setPicker] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [help, setHelp] = useState<'cli' | 'preferences' | CliProvider | null>(null);
  const [shortcut, setShortcut] = usePersistentState<CliShortcut>(CLI_SHORTCUT_KEY, 'l', { validate: isCliShortcut });
  const [showUnavailable, setShowUnavailable] = useUnavailableFeatures();
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

  return (
    <section aria-label="CLI selection" className="cli-settings">
      <header className="cli-settings-header">
        <h2 className="page-title">CLIs</h2>
        <button type="button" className="cli-info-button" aria-label="About CLI settings"
          aria-haspopup="dialog" onClick={() => setHelp('cli')}><InfoIcon size={14} /></button>
        <Button variant="secondary" disabled={busy || loading} onClick={() => { setSelected(null); reload(); }}>Refresh CLI status</Button>
      </header>
      {loading && <p role="status">Checking installed CLIs…</p>}
      <ErrorText error={error} />
      <ErrorText error={failure} />
      {info && (
        <>
          <p className="cli-settings-active">Active CLI: <strong>{info.selectionRequired ? 'Not selected' : providerLabel(info.defaultProvider)}</strong></p>
          {[true, false].map((installed) => {
            const providers = info.providers.filter((provider) => provider.installed === installed);
            if (!providers.length) return null;
            return <section key={String(installed)} className="cli-settings-group"
              aria-label={installed ? 'Installed CLIs' : 'Uninstalled CLIs'}>
              <h3>{installed ? 'Installed' : 'Not installed'}</h3>
              {providers.map((provider) => {
                const label = provider.label ?? providerLabel(provider.id);
                const open = expanded[provider.id] ?? false;
                return <section key={provider.id} className="cli-settings-provider">
                  <div className="cli-settings-provider-head">
                    <button type="button" className="cli-settings-toggle" aria-label={`${label} settings`}
                      aria-expanded={open} onClick={() => setExpanded((current) => ({ ...current, [provider.id]: !open }))}>
                      <ChevronIcon size={14} open={open} />
                      <span className="cli-provider-icon" aria-hidden><ProviderIcon providerId={provider.id} /></span>
                      <span className="cli-settings-name">{label}
                        {provider.id === 'agency' && <small>Microsoft internal only</small>}
                      </span>
                      <span className={`cli-settings-status${installed ? ' is-installed' : ''}`}>
                        {installed ? <CheckIcon size={13} /> : <CloseIcon size={13} />}
                        {installed ? 'Installed' : 'Not installed'}
                      </span>
                      {!info.selectionRequired && info.defaultProvider === provider.id && <span className="cli-settings-current">Active</span>}
                    </button>
                    <button type="button" className="cli-info-button" aria-label={`About ${label}`}
                      aria-haspopup="dialog" onClick={() => setHelp(provider)}><InfoIcon size={14} /></button>
                  </div>
                  {open && <div className="cli-settings-provider-body">
                    <div className="cli-provider-actions">
                      <Button disabled={busy || loading || !provider.installed} onClick={() => setPicker(provider.id)}>
                        Use {label}
                      </Button>
                      {!provider.installed && <Button variant="secondary" onClick={() => setSetup(true)}>Open CLI setup</Button>}
                    </div>
                    <ProviderFeatureChecklist provider={provider} hideHelp />
                    {renderProviderSettings?.(provider)}
                  </div>}
                </section>;
              })}
            </section>;
          })}
          {Boolean(info.blockers?.length) && <details className="cli-settings-options">
            <summary>Switching requirements ({info.blockers!.length})</summary>
            <div className="cli-settings-options-body">
              {info.blockers?.map((blocker) => <p key={`${blocker.kind}:${blocker.id}`}>Stop {blocker.label} before switching.</p>)}
              {info.blockers?.every((blocker) => /warm|probe|pool/i.test(blocker.kind)) && (
                <Button disabled={busy} onClick={() => void stopIdle()}>Stop idle background CLI workers</Button>
              )}
            </div>
          </details>}
        </>
      )}
      <details className="cli-settings-options">
        <summary>CLI preferences</summary>
        <div className="cli-settings-options-body">
          <button type="button" className="cli-info-button" aria-label="About CLI preferences"
            aria-haspopup="dialog" onClick={() => setHelp('preferences')}><InfoIcon size={14} /></button>
          {info && <p>Remember me: {(info.remember ?? !info.selectionRequired) ? 'On' : 'Off — choose again on restart'}</p>}
          <label className="field">
        <span><input type="checkbox" aria-label="Show unavailable IDE features (experimental)"
          checked={showUnavailable} onChange={(event) => setShowUnavailable(event.target.checked)} /> Show unavailable IDE features (experimental)</span>
      </label>
      <label className="field">
        <span>CLI picker keyboard shortcut</span>
        <select className="input" value={shortcut} onChange={(event) => {
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
        </div>
      </details>
      {help && <Modal title={typeof help === 'string' ? (help === 'cli' ? 'About CLI settings' : 'CLI preferences') : `${help.label ?? providerLabel(help.id)} information`}
        onClose={() => setHelp(null)} size="sm" className="cli-settings-help">
        {help === 'cli' ? <dl>
          <dt>Switching</dt><dd>One CLI is active globally. Switching asks permission to stop interactive work, waits for confirmed exit, and preserves every provider’s history.</dd>
          <dt>Agency</dt><dd>Microsoft internal only. Agency appears on the Microsoft network and still requires its own sign-in.</dd>
          <dt>Configuration</dt><dd>Expand a CLI to change its settings. Saved command configuration applies after restarting the app; environment variables take precedence.</dd>
        </dl> : help === 'preferences' ? <dl>
          <dt>Experimental features</dt><dd>Unavailable IDE features are hidden by default. Revealed features may fail; CLI safety policies still apply.</dd>
          <dt>Remember me</dt><dd>Change this in the CLI picker. On skips selection at startup; off asks again without deleting history.</dd>
          <dt>Keyboard shortcut</dt><dd>Open the CLI picker with your chosen shortcut, or disable it.</dd>
        </dl> : <>
          {help.id === 'agency' && <p>Microsoft internal only. Availability follows Microsoft-network detection, not your account identity. Native CLI sign-in is still required.</p>}
          <p>Feature readiness describes integration in Studio, not the CLI’s native limitations.</p>
          {help.automation?.reason && <p>{help.automation.reason}</p>}
          {help.installCommand && <><h3>Install command</h3><pre><code>{help.installCommand}</code></pre></>}
          {help.installAvailable === false && !help.installed && <p>Automatic installation unavailable.</p>}
        </>}
      </Modal>}
      {setup && <ProviderInstallGate forceChoose><p role="status">CLI setup closed. Refresh CLI status to confirm installation.</p></ProviderInstallGate>}
      {picker && <CliSelector initialProviderId={picker} onClose={() => {
        setPicker(null);
        setSelected(null);
        reload();
      }} />}
    </section>
  );
}
