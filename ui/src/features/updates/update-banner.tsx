import { useState } from 'react';
import { useAppUpdates } from '../../hooks/use-app-updates.js';

/**
 * A slim, dismissible top-of-app banner that surfaces an available/downloading/
 * ready update. Renders nothing unless the desktop bridge reports an actionable
 * update. Actions map to the electron-updater flow (download → install), with a
 * guided-install fallback on unsigned platforms (macOS).
 */
export function UpdateBanner() {
  const { ui, supported, download, install } = useAppUpdates();
  const [dismissed, setDismissed] = useState(false);

  if (!supported || !ui.showBanner || dismissed) {
    return null;
  }

  return (
    <div className={`update-banner update-banner-${ui.tone}`} role="status" aria-live="polite">
      <div className="update-banner-body">
        <div className="update-banner-text">
          <strong className="update-banner-title">{ui.headline}</strong>
          {ui.detail && <span className="update-banner-detail">{ui.detail}</span>}
        </div>
        {ui.showProgress && (
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
        )}
      </div>
      <div className="update-banner-actions">
        {ui.canDownload && (
          <button type="button" className="btn btn-primary" onClick={download}>
            {ui.autoInstall ? 'Download' : 'Get update'}
          </button>
        )}
        {ui.canInstall && (
          <button type="button" className="btn btn-primary" onClick={install}>
            {ui.autoInstall ? 'Restart & install' : 'Install…'}
          </button>
        )}
        {!ui.showProgress && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update notification"
          >
            Later
          </button>
        )}
      </div>
    </div>
  );
}
