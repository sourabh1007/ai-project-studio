import type { CommandCatalogEntry } from '../../lib/types.js';
import { Button } from '../../components/ui.js';

export const OPEN_TOOL_OWNER_EVENT = 'cw-open-tool-owner';

export function ToolsSection({ entries, query }: { entries: readonly CommandCatalogEntry[]; query: string }) {
  return (
    <section aria-label="Tool command inventory">
      <h2>Tools &amp; CLIs</h2>
      <p>One place for application-managed commands. Editors below reference each owning module; required protocol and safety arguments stay read-only. Viewing this page does not run commands or check authentication.</p>
      {entries.filter((entry) => `${entry.label} ${entry.category} ${entry.description} ${entry.sources.join(' ')}`.toLowerCase().includes(query.toLowerCase())).map((entry) => (
        <details key={entry.id} className="config-module-card">
          <summary>{entry.label} · {entry.category}</summary>
          <p>{entry.description}</p>
          {entry.config && <p>Settings owner: <code>{entry.config.namespace}</code></p>}
          <p>Required / read-only:</p>
          <ul>{entry.required.map((text) => <li key={text}>{text}</li>)}</ul>
          {entry.settingsLink && <Button variant="secondary" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_TOOL_OWNER_EVENT, { detail: entry.settingsLink }))}>
            Open {entry.settingsLink === 'mcp' ? 'MCP definitions' : 'automations'}
          </Button>}
          <details><summary>Production functions</summary><ul>{entry.sources.map((source) => <li key={source}><code>{source}</code></li>)}</ul></details>
        </details>
      ))}
    </section>
  );
}
