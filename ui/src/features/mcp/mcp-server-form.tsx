import { useRef, useState } from 'react';
import type { McpServerEntry } from '../../lib/types.js';
import { Button } from '../../components/ui.js';

/** Pretty-prints a spec object for the editor, defaulting to a helpful stub. */
function initialSpecText(entry?: McpServerEntry): string {
  if (entry) {
    return JSON.stringify(entry.spec, null, 2);
  }
  return JSON.stringify(
    { type: 'stdio', command: 'npx', args: [], env: {} },
    null,
    2,
  );
}

/**
 * Add/edit form for a single MCP server. The spec is edited as raw JSON so the
 * IDE round-trips whatever shape the provider's CLI expects without imposing a
 * fixed schema.
 */
export function McpServerForm({
  initial,
  categoryLabel,
  onSubmit,
  onCancel,
}: {
  initial?: McpServerEntry;
  categoryLabel: string;
  onSubmit: (input: { name: string; spec: Record<string, unknown> }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [specText, setSpecText] = useState(() => initialSpecText(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);

  async function submit() {
    if (locked.current) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required');
      return;
    }
    let spec: unknown;
    try {
      spec = JSON.parse(specText);
    } catch {
      setError('Configuration must be valid JSON');
      return;
    }
    if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
      setError('Configuration must be a JSON object');
      return;
    }
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, spec: spec as Record<string, unknown> });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="feature-form">
      <p className="field-hint">Category: <strong>{categoryLabel}</strong>{initial?.source ? ` - ${initial.source}` : ''}</p>
      <div className="field">
        <label htmlFor="mcp-name">Server name</label>
        <input
          id="mcp-name"
          className="input"
          autoFocus={!initial}
          value={initial?.displayName ?? name}
          disabled={Boolean(initial) || busy}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. filesystem"
        />
      </div>
      <div className="field">
        <label htmlFor="mcp-spec">Configuration (JSON)</label>
        <textarea
          id="mcp-spec"
          className="textarea textarea-lg mono"
          value={specText}
          disabled={busy}
          onChange={(event) => setSpecText(event.target.value)}
          spellCheck={false}
        />
        <p className="field-hint">
          Saved to this source using its native configuration format.
          Keep environment-variable references intact; only use fields supported by this CLI.
        </p>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="row modal-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} loading={busy}>
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Add server'}
        </Button>
      </div>
    </div>
  );
}
