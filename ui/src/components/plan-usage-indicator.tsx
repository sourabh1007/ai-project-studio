import { useState } from 'react';
import type { PlanUsage } from '../lib/types.js';
import { formatDateTime } from '../lib/format.js';
import { Modal } from './ui.js';

function aic(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Status-bar indicator for the signed-in plan's AI-credit budget. Shows a
 * compact "N% used · resets in Nd" chip mirroring the CLI `/usage` footer, and
 * opens a details modal (used / available / total, progress, reset, session
 * spend) on click. Renders nothing until the first snapshot is captured.
 */
export function PlanUsageIndicator({ usage }: { usage: PlanUsage | null }) {
  const [open, setOpen] = useState(false);
  if (usage === null) {
    return null;
  }

  const reset =
    usage.resetInDays !== null ? ` · resets in ${usage.resetInDays}d` : '';

  return (
    <>
      <button
        type="button"
        className="statusbar-item statusbar-plan"
        onClick={() => setOpen(true)}
        title="Copilot plan AI-credit budget — click for details"
      >
        ◈ {usage.percentUsed}% used{reset}
      </button>
      {open && <PlanUsageModal usage={usage} onClose={() => setOpen(false)} />}
    </>
  );
}

function PlanUsageModal({
  usage,
  onClose,
}: {
  usage: PlanUsage;
  onClose: () => void;
}) {
  const pct = Math.max(0, Math.min(100, usage.percentUsed));
  return (
    <Modal title="Plan AI credits" onClose={onClose}>
      <div className="plan-usage">
        <p className="plan-usage-sub">
          Your Copilot plan's AI-credit budget for this billing period, as
          reported by the CLI <code>/usage</code>.
        </p>

        <div className="plan-usage-bar" role="img" aria-label={`${pct}% used`}>
          <div className="plan-usage-bar-fill" style={{ width: `${pct}%` }} />
        </div>

        <div className="plan-usage-grid">
          <div className="plan-usage-cell">
            <span className="plan-usage-value">{aic(usage.usedAic)}</span>
            <span className="plan-usage-label">Used ({usage.percentUsed}%)</span>
          </div>
          <div className="plan-usage-cell">
            <span className="plan-usage-value">{aic(usage.availableAic)}</span>
            <span className="plan-usage-label">Available</span>
          </div>
          <div className="plan-usage-cell">
            <span className="plan-usage-value">{aic(usage.totalAic)}</span>
            <span className="plan-usage-label">Total AIC</span>
          </div>
          {usage.resetInDays !== null && (
            <div className="plan-usage-cell">
              <span className="plan-usage-value">{usage.resetInDays}</span>
              <span className="plan-usage-label">Days to reset</span>
            </div>
          )}
          {usage.sessionAic !== null && (
            <div className="plan-usage-cell">
              <span className="plan-usage-value">{aic(usage.sessionAic)}</span>
              <span className="plan-usage-label">This session</span>
            </div>
          )}
        </div>

        <p className="plan-usage-captured">
          Updated {formatDateTime(usage.capturedAt)}
        </p>
      </div>
    </Modal>
  );
}
