import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import type { ProviderSelectionInfo } from '../../lib/api.js';
import { announceProvider } from '../../lib/provider-selection.js';
import { providerLabel } from '../../lib/meta-model.js';
import { Button, ConfirmDialog, ErrorText, Modal } from '../../components/ui.js';

export function CliSelector({ onClose, initialProviderId = null }: { onClose: () => void; initialProviderId?: string | null }) {
  const api = useApi();
  const [info, setInfo] = useState<ProviderSelectionInfo | null>(null);
  const [remember, setRemember] = useState(false);
  const [target, setTarget] = useState<string | null>(initialProviderId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    void api.getProviderBootstrap().then((result) => {
      if (!mounted.current) return;
      setInfo(result);
      setRemember(result.remember ?? !result.selectionRequired);
    }).catch((failure: unknown) => {
      if (mounted.current) setError(failure instanceof Error ? failure.message : String(failure));
    });
    return () => { mounted.current = false; };
  }, [api]);

  async function switchCli() {
    if (!target || !info || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const selected = await api.switchProvider({
        providerId: target, remember, expectedRevision: info.revision ?? 0,
      });
      if (selected.selectionRequired || selected.defaultProvider !== target) {
        throw new Error('The server did not confirm the selected CLI.');
      }
      announceProvider(selected);
      if (mounted.current) onClose();
    } catch (failure: unknown) {
      if (mounted.current) {
        setError(failure instanceof Error ? failure.message : String(failure));
        setTarget(null);
        try { setInfo(await api.getProviderBootstrap()); } catch { /* Keep the last confirmed state. */ }
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal title="Choose active CLI" onClose={onClose} dismissible={!busy}>
      <p>One CLI is active globally. Other providers’ sessions and history are retained.</p>
      <ErrorText error={error} />
      {!info && !error && <p role="status">Checking installed CLIs…</p>}
      {info && <p>Current CLI: <strong>{info.selectionRequired ? 'Not selected' : providerLabel(info.defaultProvider)}</strong></p>}
      <label className="field">
        <span><input type="checkbox" aria-label="Remember me" checked={remember} disabled={busy} onChange={(event) => setRemember(event.target.checked)} /> Remember me</span>
        <span className="field-hint">Skip startup selection next time. Unchecked clears any previously remembered CLI.</span>
      </label>
      {info?.providers.map((provider) => (
        <div className="config-namespace" key={provider.id}>
          <strong>{provider.label ?? providerLabel(provider.id)}</strong>
          <p>{provider.installed ? 'Installed' : 'Not installed — configure installation in Settings → CLI.'}</p>
          {provider.automation?.supported === false && <p>Interactive use only — automated AI is unavailable. {provider.automation.reason} Choose another CLI for agents and AI planning.</p>}
          {!provider.automation && <p>Automation readiness is unreported. Selecting this CLI does not confirm agent or AI planning support.</p>}
          <Button disabled={busy || !provider.installed} onClick={() => setTarget(provider.id)}>
            Use {provider.label ?? providerLabel(provider.id)}
          </Button>
        </div>
      ))}
      {info?.blockers?.map((blocker) => <p key={`${blocker.kind}:${blocker.id}`}>{blocker.label}</p>)}
      {target && <ConfirmDialog
        title="Switch active CLI?"
        confirmLabel={busy ? 'Waiting for CLI exit…' : 'Stop CLI work and switch'}
        busy={busy || !info}
        onCancel={() => setTarget(null)}
        onConfirm={() => void switchCli()}
        message={<p>Save unsent composer text before continuing. Running interactive CLI work will be interrupted; history is preserved. Background AI work that cannot be safely stopped will block the switch. The current feature will resume a compatible session or open a new one; old prompts are never submitted automatically.</p>}
      />}
    </Modal>
  );
}
