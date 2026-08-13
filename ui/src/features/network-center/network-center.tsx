import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  NETWORK_INTEGRATIONS,
  categoryLabel,
  filterIntegrations,
  groupIntegrationsByProvider,
  listCategories,
  sensitivityLabel,
  summarizeEgress,
  SENSITIVITY_ORDER,
  type DataSensitivity,
  type IntegrationCategory,
  type NetworkIntegration,
} from '../../lib/network-activity.js';

interface NetworkCenterProps {
  open: boolean;
  onClose: () => void;
}

type CategoryFilter = IntegrationCategory | 'all';
type SensitivityFilter = DataSensitivity | 'all';

function IntegrationCard({ integration }: { integration: NetworkIntegration }) {
  return (
    <li className="netcenter-item">
      <div className="netcenter-item-head">
        <span className="netcenter-item-purpose">{integration.purpose}</span>
        <span className="netcenter-badges">
          <span className="netcenter-badge">
            {categoryLabel(integration.category)}
          </span>
          <span
            className={`netcenter-badge netcenter-badge-sens netcenter-sens-${integration.sensitivity}`}
          >
            {sensitivityLabel(integration.sensitivity)}
          </span>
          {integration.requiresAuth && (
            <span className="netcenter-badge netcenter-badge-auth">
              Authenticated
            </span>
          )}
          {integration.configurable && (
            <span className="netcenter-badge netcenter-badge-cfg">
              Configurable
            </span>
          )}
        </span>
      </div>
      <p className="netcenter-item-data">{integration.dataShared}</p>
      <ul className="netcenter-endpoints">
        {integration.endpoints.map((endpoint) => (
          <li key={endpoint} className="netcenter-endpoint">
            <code>{endpoint}</code>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Network Activity Center (Phase 5c) — a full, filterable transparency surface
 * built on the same curated catalog as the compact Settings summary (1a). Opened
 * from the command palette, it lets the user search and filter every outbound
 * integration by category, sensitivity, and authentication, and drills into the
 * concrete endpoints each one contacts (per-operation egress detail). Read-only
 * and offline: it renders a static, reviewable inventory — it does not sniff live
 * traffic.
 */
export function NetworkCenter({ open, onClose }: NetworkCenterProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sensitivity, setSensitivity] = useState<SensitivityFilter>('all');
  const [authOnly, setAuthOnly] = useState(false);

  const categories = useMemo(() => listCategories(), []);
  const summary = useMemo(() => summarizeEgress(), []);
  const filtered = useMemo(
    () =>
      filterIntegrations(NETWORK_INTEGRATIONS, {
        query,
        category,
        sensitivity,
        authOnly,
      }),
    [query, category, sensitivity, authOnly],
  );
  const groups = useMemo(
    () => groupIntegrationsByProvider(filtered),
    [filtered],
  );

  if (!open) {
    return null;
  }

  return createPortal(
    <div
      className="cmdk-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="netcenter-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Network Activity Center"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        ref={(node) => node?.focus()}
      >
        <header className="netcenter-header">
          <div>
            <h2 className="netcenter-title">Network Activity Center</h2>
            <p className="netcenter-subtitle">
              Every outbound integration this app uses, what it is for, and the
              exact endpoints it contacts. Read-only and reviewable —{' '}
              {summary.total} integrations · {summary.authenticated} authenticated
              · {summary.highSensitivity} sensitive.
            </p>
          </div>
          <button
            type="button"
            className="netcenter-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="netcenter-filters">
          <input
            className="netcenter-search"
            type="search"
            value={query}
            placeholder="Search provider, purpose, or endpoint…"
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="netcenter-chips" role="group" aria-label="Category">
            <button
              type="button"
              className={`netcenter-chip ${category === 'all' ? 'is-active' : ''}`.trim()}
              onClick={() => setCategory('all')}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                className={`netcenter-chip ${category === cat ? 'is-active' : ''}`.trim()}
                onClick={() => setCategory(cat)}
              >
                {categoryLabel(cat)}
              </button>
            ))}
          </div>
          <div className="netcenter-chips" role="group" aria-label="Sensitivity">
            <button
              type="button"
              className={`netcenter-chip ${sensitivity === 'all' ? 'is-active' : ''}`.trim()}
              onClick={() => setSensitivity('all')}
            >
              Any sensitivity
            </button>
            {SENSITIVITY_ORDER.map((level) => (
              <button
                key={level}
                type="button"
                className={`netcenter-chip ${sensitivity === level ? 'is-active' : ''}`.trim()}
                onClick={() => setSensitivity(level)}
              >
                {sensitivityLabel(level)}
              </button>
            ))}
          </div>
          <label className="netcenter-toggle">
            <input
              type="checkbox"
              checked={authOnly}
              onChange={(event) => setAuthOnly(event.target.checked)}
            />
            Authenticated only
          </label>
        </div>

        <div className="netcenter-results">
          {groups.length === 0 ? (
            <p className="netcenter-empty">
              No integrations match these filters.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.provider} className="netcenter-group">
                <h3 className="netcenter-group-title">{group.provider}</h3>
                <ul className="netcenter-list">
                  {group.integrations.map((integration) => (
                    <IntegrationCard
                      key={integration.id}
                      integration={integration}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
