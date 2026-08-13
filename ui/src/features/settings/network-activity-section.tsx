import { Card } from '../../components/ui.js';
import {
  categoryLabel,
  groupIntegrationsByProvider,
  sensitivityLabel,
  summarizeEgress,
  type NetworkIntegration,
} from '../../lib/network-activity.js';
import {
  CREDENTIAL_STORES,
  allDelegated,
} from '../../lib/credential-storage.js';

/**
 * Settings ▸ "Network activity" — a read-only transparency surface (Phase 1a).
 *
 * AI Project Studio is inherently cloud-connected (Copilot, GitHub, Azure, MCP),
 * so instead of pretending to be offline-first we lead with honesty: this block
 * lists every outbound integration the app uses, its purpose, and what data
 * leaves the machine. It is informational only — nothing here changes state.
 */
function IntegrationRow({ integration }: { integration: NetworkIntegration }) {
  return (
    <li className="netact-item">
      <div className="netact-item-head">
        <span className="netact-item-purpose">{integration.purpose}</span>
        <span className="netact-badges">
          <span className="netact-badge">{categoryLabel(integration.category)}</span>
          {integration.requiresAuth && (
            <span className="netact-badge netact-badge-auth">Authenticated</span>
          )}
          <span
            className={`netact-badge netact-badge-sens netact-sens-${integration.sensitivity}`}
          >
            {sensitivityLabel(integration.sensitivity)}
          </span>
        </span>
      </div>
      <p className="netact-item-data">{integration.dataShared}</p>
      <div className="netact-endpoints">
        {integration.endpoints.map((endpoint) => (
          <code className="netact-endpoint" key={endpoint}>
            {endpoint}
          </code>
        ))}
        {integration.configurable && (
          <span className="netact-note">Depends on your configuration</span>
        )}
      </div>
    </li>
  );
}

export function NetworkActivitySection() {
  const groups = groupIntegrationsByProvider();
  const summary = summarizeEgress();

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Network activity</h2>
          <p className="page-subtitle">
            AI Project Studio connects to cloud services to do its work. This is
            every outbound integration it uses, what it is for, and what data
            leaves your machine. Nothing here is tracked live — it is a reviewable
            inventory.
          </p>
        </div>
      </div>

      <div className="netact-summary">
        <span>
          <strong>{summary.total}</strong> integrations
        </span>
        <span>
          <strong>{summary.authenticated}</strong> send credentials
        </span>
        <span>
          <strong>{summary.highSensitivity}</strong> send sensitive data
        </span>
      </div>

      <div className="netact-groups">
        {groups.map((group) => (
          <div className="netact-group" key={group.provider}>
            <h3 className="netact-provider">{group.provider}</h3>
            <ul className="netact-list">
              {group.integrations.map((integration) => (
                <IntegrationRow integration={integration} key={integration.id} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="netact-credentials">
        <h3 className="netact-provider">Credentials &amp; secrets</h3>
        {allDelegated() && (
          <p className="netact-cred-lead">
            AI Project Studio stores no tokens of its own — every credential lives
            in an OS-backed store or the underlying CLI, and is fetched only when
            needed.
          </p>
        )}
        <ul className="netact-list">
          {CREDENTIAL_STORES.map((store) => (
            <li className="netact-item" key={store.id}>
              <div className="netact-item-head">
                <span className="netact-item-purpose">{store.name}</span>
                <span className="netact-badges">
                  <span className="netact-badge netact-badge-store">
                    {store.backing}
                  </span>
                </span>
              </div>
              <p className="netact-item-data">{store.description}</p>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
