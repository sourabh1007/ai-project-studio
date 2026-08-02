import { useMemo, useState } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import type { ConfigValue } from '../../lib/types.js';
import { Card, EmptyState, ErrorText } from '../../components/ui.js';
import { Loader } from '../../components/loading.js';

function renderValue(value: ConfigValue): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

export function SettingsView() {
  const api = useApi();
  const { data, loading, error } = useAsync(() => api.getConfig(), []);
  const [query, setQuery] = useState('');

  const namespaces = useMemo(() => {
    if (!data) {
      return [];
    }
    const term = query.trim().toLowerCase();
    return data.namespaces
      .map((namespace) => {
        const settings = data.current[namespace] ?? {};
        const entries = Object.entries(settings).filter(
          ([key]) => !term || `${namespace}.${key}`.toLowerCase().includes(term),
        );
        return { namespace, entries };
      })
      .filter((group) => group.entries.length > 0);
  }, [data, query]);

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="page-subtitle">
            Effective configuration, grouped by module. Every value is
            config-driven — nothing is hardcoded.
          </p>
        </div>
        <input
          className="input"
          style={{ maxWidth: 260 }}
          placeholder="Filter settings…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {loading && <Loader label="Loading configuration" />}
      <ErrorText error={error} />
      {data && namespaces.length === 0 && (
        <EmptyState message="No matching settings." />
      )}
      <div style={{ marginTop: 'var(--space-4)' }}>
        {namespaces.map((group) => (
          <div key={group.namespace} className="config-namespace">
            <h3>{group.namespace}</h3>
            <dl className="kv">
              {group.entries.map(([key, value]) => (
                <div key={key} style={{ display: 'contents' }}>
                  <dt>{key}</dt>
                  <dd>{renderValue(value)}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}
