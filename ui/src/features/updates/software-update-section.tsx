import { Button, Card } from '../../components/ui.js';
import { useAppUpdates } from '../../hooks/use-app-updates.js';

/**
 * The "Software update" block for the Settings ▸ About area. Shows the current
 * and available versions, a manual "Check for updates" action, download
 * progress, release notes, and the install action. Only meaningful inside the
 * desktop shell; renders a short note in the browser.
 */
export function SoftwareUpdateSection() {
  const { state, ui, supported, check, download, install } = useAppUpdates();

  if (!supported) {
    return (
      <Card>
        <div className="page-header">
          <div>
            <h2 className="page-title">Software updates</h2>
            <p className="page-subtitle">
              Automatic updates are available in the desktop app.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Software updates</h2>
          <p className="page-subtitle">{ui.headline}</p>
        </div>
        <Button variant="ghost" onClick={check} disabled={!ui.canCheck}>
          {ui.busy && state.status === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      </div>

      <dl className="kv">
        <div style={{ display: 'contents' }}>
          <dt>Current version</dt>
          <dd>{state.currentVersion ? `v${state.currentVersion}` : '—'}</dd>
        </div>
        {state.availableVersion && state.availableVersion !== state.currentVersion && (
          <div style={{ display: 'contents' }}>
            <dt>Available version</dt>
            <dd>v{state.availableVersion}</dd>
          </div>
        )}
      </dl>

      {ui.showProgress && (
        <div className="update-section-progress">
          <div
            className="update-banner-progress"
            role="progressbar"
            aria-valuenow={ui.progressPercent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className="update-banner-progress-fill"
              style={{ width: `${ui.progressPercent}%` }}
            />
          </div>
          {ui.detail && <p className="page-subtitle">{ui.detail}</p>}
        </div>
      )}

      {state.status === 'error' && ui.detail && (
        <p className="update-section-error" role="alert">
          {ui.detail}
        </p>
      )}

      {state.releaseNotes && (
        <details className="update-section-notes">
          <summary>Release notes</summary>
          <pre className="update-section-notes-body">{state.releaseNotes}</pre>
        </details>
      )}

      {(ui.canDownload || ui.canInstall) && (
        <div className="update-section-actions">
          {ui.canDownload && (
            <Button onClick={download}>
              {ui.autoInstall ? 'Download update' : 'Get update'}
            </Button>
          )}
          {ui.canInstall && (
            <Button onClick={install}>
              {ui.autoInstall ? 'Restart & install' : 'Install…'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
