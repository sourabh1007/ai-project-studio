import { useState } from 'react';
import type { McpServerEntry } from '../../lib/types.js';
import { Button, ErrorText } from '../../components/ui.js';

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
  onSubmit,
  onCancel,
}: {
  initial?: McpServerEntry;
  onSubmit: (input: { name: string; spec: Record<string, unknown> }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [specText, setSpecText] = useState(() => initialSpecText(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
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
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: trimmed, spec: spec as Record<string, unknown> });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feature-form">
      <div className="field">
        <label htmlFor="mcp-name">Server name</label>
        <input
          id="mcp-name"
          className="input"
          autoFocus={!initial}
          value={name}
          disabled={Boolean(initial)}
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
          onChange={(event) => setSpecText(event.target.value)}
          spellCheck={false}
        />
        <p className="field-hint">
          Stored verbatim under <code>mcpServers</code> in the provider’s config
          file.
        </p>
      </div>
      <ErrorText error={error} />
      <div className="row modal-actions">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Add server'}
        </Button>
      </div>
    </div>
  );
}
