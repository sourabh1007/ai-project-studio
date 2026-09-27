import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { Button, ErrorText, Modal } from '../../components/ui.js';
import type { McpServerEntry, McpCommandOptionsInfo } from '../../lib/types.js';
import { Spinner } from '../../components/loading.js';
import { McpCommandOptions } from './mcp-command-options.js';

export function McpBuiltinSetup({ providerId, server, onClose, onConfigured }: {
  providerId: string;
  server: McpServerEntry;
  onClose: () => void;
  onConfigured: () => void;
}) {
  const api = useApi();
  const [args, setArgs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [options, setOptions] = useState<McpCommandOptionsInfo | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refreshAttempts = useRef(0);
  const locked = useRef(false);
  const name = server.builtinName ?? server.displayName ?? server.name;
  const canConfigure = Boolean(server.catalog ? server.capabilities?.add.supported : server.capabilities?.edit.supported);
  const spec = `${name} ${args.trim()}`.trim();
  const command = `agency config set --global --mcp '${spec.replace(/'/g, "''")}'`;

  useEffect(() => {
    let active = true;
    setOptionsLoading(true);
    setOptionsError(null);
    api.getMcpCommandOptions(providerId, server.name).then((result) => {
      if (active) setOptions(result);
    }).catch((err: unknown) => {
      if (active) setOptionsError(err instanceof Error ? err.message : String(err));
    }).finally(() => { if (active) setOptionsLoading(false); });
    return () => { active = false; };
  }, [api, providerId, server.name, revision]);

  useEffect(() => {
    if (!options?.stale || optionsLoading || optionsError || refreshAttempts.current >= 5) return;
    const timer = setTimeout(() => {
      refreshAttempts.current += 1;
      setRevision((value) => value + 1);
    }, 2000);
    return () => clearTimeout(timer);
  }, [options, optionsLoading, optionsError]);

  async function configure() {
    if (locked.current || !canConfigure || saved) return;
    if (/[\r\n\0]/.test(args) || args.length > 4096) {
      setError('Enter one line of arguments, at most 4096 characters.');
      return;
    }
    if (/^(?:agency(?:\.exe)?\s|config\s+set\b|mcp\s)/i.test(args.trim()) || args.trim() === name || args.trim().startsWith(`${name} `)) {
      setError('Enter options only, for example --organization myorg. The server command is already included.');
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.configureMcpBuiltin(providerId, server.name, { arguments: args.trim() });
      setSaved(true);
      onConfigured();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal title={`Configure ${name}`} onClose={() => { if (!locked.current) onClose(); }} size="lg">
      <form className="mcp-builtin-setup" aria-busy={busy}
        onSubmit={(event) => { event.preventDefault(); void configure(); }}>
        <p>Choose options or enter your own. Saves for new Agency sessions.</p>
        {!server.catalog && <>
          <p role="note">Replaces this built-in's options and may re-enable it.</p>
          <details>
            <summary>Current saved settings</summary>
            <pre className="mcp-setup-command">{JSON.stringify(server.spec, null, 2)}</pre>
          </details>
        </>}
        <div className="field">
          <label htmlFor="mcp-builtin-args">Server arguments</label>
          <input id="mcp-builtin-args" className="input" value={args} disabled={busy || saved}
            onChange={(event) => setArgs(event.target.value)} maxLength={4096}
            placeholder={name === 'ado' ? '--organization myorg' : 'Optional server-specific flags'} />
          <p className="field-hint">Options only. The command and server name are included below.</p>
        </div>
        {optionsLoading && <div className="mcp-operation-progress"><Spinner size={18} label="Loading command options" /><span>Loading command options...</span></div>}
        {optionsError && <div><ErrorText error={optionsError} /><Button variant="ghost" onClick={() => {
          refreshAttempts.current = 0;
          setRevision((value) => value + 1);
        }}>Retry options</Button></div>}
        {options && <>
          <McpCommandOptions options={options.options} examples={options.examples} disabled={busy || saved}
            onChoose={(fragment) => setArgs((current) => options.examples.includes(fragment)
              ? fragment : `${current.trim()} ${fragment}`.trim())} />
          <p className="field-hint">{options.stale
            ? optionsError || refreshAttempts.current >= 5 ? 'Using cached options.' : 'Refreshing cached options.'
            : 'Options from installed Agency.'}</p>
          {options.message && <p className="field-hint">{options.message}</p>}
        </>}
        <div className="field">
          <span className="field-hint">Command executed by the IDE</span>
          <pre className="mcp-setup-command">{command}</pre>
        </div>
        {!canConfigure && <ErrorText error="This entry cannot be configured from the IDE." />}
        <ErrorText error={error} />
        {busy && <div className="mcp-operation-progress"><Spinner size={22} label="Running configuration command" /><span>Running setup and verifying saved settings...</span></div>}
        {saved && <p className="mcp-notice" role="status">Saved. Use Tools or Auth on the server card.</p>}
        <div className="row modal-actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{saved ? 'Done' : 'Cancel'}</Button>
          {!saved && <Button type="submit" loading={busy} disabled={!canConfigure}>
            {busy ? 'Configuring...' : 'Configure server'}
          </Button>}
        </div>
      </form>
    </Modal>
  );
}
