import { formatCredits, formatTokens } from '../../lib/format.js';
import type { SessionLiveTotals } from '../../lib/stream.js';
import { Stat } from '../../components/ui.js';

export function LiveCreditMeter({
  totals,
  budget,
}: {
  totals: SessionLiveTotals;
  budget?: number;
}) {
  const pct =
    budget && budget > 0
      ? Math.min(100, (totals.credits / budget) * 100)
      : null;
  return (
    <div>
      <div className="grid grid-stats">
        <Stat label="Live credits" value={formatCredits(totals.credits)} />
        <Stat label="Turns" value={totals.turns} />
        <Stat label="Input tokens" value={formatTokens(totals.inputTokens)} />
        <Stat label="Output tokens" value={formatTokens(totals.outputTokens)} />
      </div>
      {pct !== null && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="meter" role="progressbar" aria-valuenow={pct}>
            <div className="meter-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="muted">{pct.toFixed(0)}% of budget</span>
        </div>
      )}
    </div>
  );
}
