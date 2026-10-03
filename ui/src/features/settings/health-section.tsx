import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../../app/api-context.js';
import { useAsync } from '../../hooks/use-async.js';
import { Button } from '../../components/ui.js';
import {
  CheckIcon,
  WarningIcon,
  CloseIcon,
  RefreshIcon,
  RestartIcon,
  ClockIcon,
  InfoIcon,
  ActivityIcon,
  OverviewIcon,
  LogsIcon,
  AiIcon,
} from '../../components/icons.js';
import type { ApiClient } from '../../lib/api.js';
import type {
  HealthState,
  HealthCheckResult,
  ProviderHealth,
  SystemHealthReport,
  HealthStatus,
} from '../../lib/types.js';
import { useMicrosoftSignedIn } from '../../hooks/use-microsoft-identity.js';
import { isProviderExposed } from '../../lib/microsoft-identity.js';

/** The Electron preload bridge, present only in the desktop app. */
interface HealthBridge {
  relaunch?(): Promise<boolean>;
  revealFile?(path: string): void;
}

interface HealthSectionProps {
  bridge?: HealthBridge;
  embedded?: boolean;
  /** App version, surfaced by the desktop shell. */
  version?: string | null;
  /** Active log directory, for the "open logs" affordance. */
  logDirectory?: string | null;
  /** Auto-refresh cadence in ms; 0 disables the live poll (used by tests). */
  pollMs?: number;
}

const STATE_LABEL: Record<HealthState, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
};

const OVERALL_HEADLINE: Record<HealthState, string> = {
  ok: 'All systems operational',
  degraded: 'Running with degraded subsystems',
  down: 'A subsystem is down',
};

function StateIcon({ state, size = 16 }: { state: HealthState; size?: number }) {
  if (state === 'ok') return <CheckIcon size={size} className="health-ic health-ic-ok" />;
  if (state === 'degraded')
    return <WarningIcon size={size} className="health-ic health-ic-degraded" />;
  return <CloseIcon size={size} className="health-ic health-ic-down" />;
}

/** The real backend endpoints the UI leans on, pinged live for latency. */
const ENDPOINTS: {
  id: string;
  label: string;
  route: string;
  run: (api: ApiClient) => Promise<unknown>;
}[] = [
  { id: 'liveness', label: 'Liveness', route: 'GET /health', run: (a) => a.checkHealth() },
  { id: 'system', label: 'System health', route: 'GET /system-health', run: (a) => a.getSystemHealth() },
  { id: 'config', label: 'Configuration', route: 'GET /config', run: (a) => a.getConfig() },
  { id: 'bootstrap', label: 'Provider bootstrap', route: 'GET /providers/bootstrap', run: (a) => a.getProviderBootstrap() },
  { id: 'agency', label: 'Agency status', route: 'GET /agency/status', run: (a) => a.getAgencyStatus() },
];

interface EndpointPing {
  id: string;
  label: string;
  route: string;
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

async function pingEndpoint(
  api: ApiClient,
  def: (typeof ENDPOINTS)[number],
): Promise<EndpointPing> {
  const started = performance.now();
  try {
    await def.run(api);
    return {
      id: def.id,
      label: def.label,
      route: def.route,
      ok: true,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      id: def.id,
      label: def.label,
      route: def.route,
      ok: false,
      latencyMs: Math.round(performance.now() - started),
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Buckets a latency into a heat tier used for the live-endpoint bar colour. */
function latencyTier(ms: number): 'fast' | 'ok' | 'slow' | 'bad' {
  if (ms < 50) return 'fast';
  if (ms < 200) return 'ok';
  if (ms < 600) return 'slow';
  return 'bad';
}

/** Scales a latency to a 4–100 bar width (saturating at ~800ms). */
function latencyWidth(ms: number): number {
  return Math.max(4, Math.min(100, Math.round((ms / 800) * 100)));
}

function formatUptime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function providerState(provider: ProviderHealth): HealthState {
  if (!provider.installed) return 'degraded';
  return provider.upgradePhase === 'error' ? 'degraded' : 'ok';
}

function providerSummary(provider: ProviderHealth): string {
  if (provider.detail) return provider.detail;
  return [
    provider.version ? `v${provider.version}` : null,
    provider.upgradePhase && provider.upgradePhase !== 'idle'
      ? `upgrade: ${provider.upgradePhase}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function InfoCard({
  icon,
  label,
  value,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const className = onClick
    ? 'health-info-card health-info-card-button'
    : 'health-info-card';
  const content = (
    <>
      <span className="health-info-icon">{icon}</span>
      <span className="health-info-text">
        <span className="health-info-label">{label}</span>
        <span className="health-info-value" title={value}>{value}</span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className={className} onClick={onClick}>{content}</button>
  ) : (
    <div className={className}>{content}</div>
  );
}

function CheckRow({ check }: { check: HealthCheckResult }) {
  return (
    <li className="health-row">
      <StateIcon state={check.state} />
      <span className="health-row-title">{check.title}</span>
      <span className={`health-badge health-badge-${check.state}`}>
        {STATE_LABEL[check.state]}
      </span>
      <span className="health-row-detail">{check.detail ?? ''}</span>
      <span className="health-row-latency">{check.latencyMs} ms</span>
    </li>
  );
}

function EndpointRow({ ping }: { ping: EndpointPing }) {
  const tier = ping.ok ? latencyTier(ping.latencyMs) : 'bad';
  return (
    <li className="health-endpoint" title={ping.detail ?? ping.route}>
      <StateIcon state={ping.ok ? 'ok' : 'down'} />
      <span className="health-endpoint-label">
        <span className="health-endpoint-name">{ping.label}</span>
        <code className="health-endpoint-route">{ping.route}</code>
      </span>
      <span className="health-endpoint-meter" aria-hidden>
        <span
          className={`health-endpoint-bar health-endpoint-bar-${tier}`}
          style={{ width: `${latencyWidth(ping.latencyMs)}%` }}
        />
      </span>
      <span className="health-endpoint-latency">{ping.latencyMs} ms</span>
    </li>
  );
}

function ProviderRow({ provider }: { provider: ProviderHealth }) {
  const state = providerState(provider);
  return (
    <li className="health-row">
      <StateIcon state={state} />
      <span className="health-row-title">{provider.title}</span>
      <span className={`health-badge health-badge-${provider.installed ? 'ok' : 'degraded'}`}>
        {provider.installed ? 'Installed' : 'Not installed'}
      </span>
      <span className="health-row-detail">{providerSummary(provider)}</span>
    </li>
  );
}

interface HealthSnapshot {
  report: SystemHealthReport | null;
  liveness: HealthStatus | null;
  endpoints: EndpointPing[];
}

/**
 * Settings ▸ System.
 *
 * A single, icon-driven home for everything about this app instance: build/app
 * info, a live latency heatmap of the backend endpoints the UI depends on, the
 * health of each backend subsystem, and each configured AI provider. The overall
 * badge reflects the worst subsystem state; providers are informational (an
 * on-demand CLI that isn't installed yet is normal, not a failure). When
 * something is wrong, restart the app to bring the backend back up.
 */
export function HealthSection({
  bridge,
  embedded,
  version,
  logDirectory,
  pollMs = 15000,
}: HealthSectionProps) {
  const api = useApi();
  const microsoftSignedIn = useMicrosoftSignedIn();
  // Agency is an internal Microsoft tool: drop its endpoint ping and provider
  // row entirely for users who are not signed in with a Microsoft identity.
  const activeEndpoints = ENDPOINTS.filter((def) =>
    isProviderExposed(def.id, microsoftSignedIn),
  );
  const { data, loading, error, reload } = useAsync<HealthSnapshot>(async () => {
    const [report, liveness, endpoints] = await Promise.all([
      api.getSystemHealth().catch(() => null),
      api.checkHealth().catch(() => null),
      Promise.all(activeEndpoints.map((def) => pingEndpoint(api, def))),
    ]);
    return { report, liveness, endpoints };
  }, [microsoftSignedIn]);

  // Live poll: refresh the snapshot on a cadence so latency stays current while
  // the page is open. Disabled when pollMs is 0 (tests) or the tab is hidden.
  useEffect(() => {
    if (!pollMs) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) reload();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, reload]);

  const report = data?.report ?? null;
  const overall: HealthState = report?.overall ?? (error ? 'down' : 'ok');
  const platform = typeof navigator === 'undefined' ? 'unknown' : navigator.platform;

  return (
    <div className={embedded ? 'health-section health-section-embedded' : 'health-section'}>
      {embedded && <h2 className="sr-only">System</h2>}

      <div className={`health-hero health-hero-${overall}`}>
        <span className="health-hero-icon">
          <StateIcon state={overall} size={28} />
        </span>
        <span className="health-hero-text">
          <strong className="health-hero-title">{OVERALL_HEADLINE[overall]}</strong>
          <span className="health-hero-sub">
            {data
              ? `Last checked ${new Date().toLocaleTimeString()}`
              : loading
                ? 'Checking…'
                : 'Status unavailable'}
          </span>
        </span>
        <span className="health-hero-actions">
          <Button variant="ghost" onClick={reload} disabled={loading}>
            <RefreshIcon size={15} /> {loading ? 'Checking…' : 'Refresh'}
          </Button>
          {!embedded && bridge?.relaunch && (
            <Button variant="ghost" onClick={() => void bridge.relaunch?.()}>
              <RestartIcon size={15} /> Restart app
            </Button>
          )}
        </span>
      </div>

      {error && (
        <p className="health-error" role="alert">
          Could not reach the backend health endpoint. The backend may be down —
          try restarting the app.
        </p>
      )}

      <div className="health-info-grid">
        <InfoCard icon={<InfoIcon size={18} />} label="App version" value={version ?? '—'} />
        <InfoCard icon={<OverviewIcon size={18} />} label="Platform" value={platform} />
        <InfoCard
          icon={<ClockIcon size={18} />}
          label="Backend uptime"
          value={formatUptime(data?.liveness?.uptimeMs)}
        />
        <InfoCard
          icon={<LogsIcon size={18} />}
          label="Log directory"
          value={logDirectory ?? '—'}
          onClick={
            logDirectory && bridge?.revealFile
              ? () => bridge.revealFile?.(logDirectory)
              : undefined
          }
        />
      </div>

      <section className="health-group">
        <h3 className="health-group-title">
          <ActivityIcon size={16} /> Live endpoints
        </h3>
        <ul className="health-list health-endpoints">
          {(data?.endpoints ?? []).map((ping) => (
            <EndpointRow ping={ping} key={ping.id} />
          ))}
        </ul>
      </section>

      <section className="health-group">
        <h3 className="health-group-title">
          <OverviewIcon size={16} /> Backend subsystems
        </h3>
        {report ? (
          <ul className="health-list">
            {report.checks.map((check) => (
              <CheckRow check={check} key={check.id} />
            ))}
          </ul>
        ) : (
          <p className="health-empty">Subsystem report unavailable.</p>
        )}
      </section>

      <section className="health-group">
        <h3 className="health-group-title">
          <AiIcon size={16} /> AI providers
        </h3>
        {report ? (
          <ul className="health-list">
            {report.providers
              .filter((provider) => isProviderExposed(provider.id, microsoftSignedIn))
              .map((provider) => (
                <ProviderRow provider={provider} key={provider.id} />
              ))}
          </ul>
        ) : (
          <p className="health-empty">Provider report unavailable.</p>
        )}
      </section>
    </div>
  );
}
