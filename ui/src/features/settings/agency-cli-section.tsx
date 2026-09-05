import { useEffect, useState } from 'react';
import { Card } from '../../components/ui.js';
import { useApi } from '../../app/api-context.js';
import { deriveAgencyUpgradeUi } from '../../lib/agency-upgrade.js';
import type { AgencyStatus } from '../../lib/types.js';

/**
 * Settings ▸ About card for the Microsoft Agency CLI. The IDE keeps agency
 * current automatically at startup (see backend agency-bootstrapper); this card
 * simply reflects that state so the user never has to run an in-session upgrade.
 * It polls status on mount and, while an upgrade is in flight, re-polls until it
 * settles.
 */
export function AgencyCliSection() {
  const api = useApi();
  const [status, setStatus] = useState<AgencyStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = (): void => {
      api
        .getAgencyStatus()
        .then((next) => {
          if (cancelled) {
            return;
          }
          setStatus(next);
          if (next.upgrade?.phase === 'upgrading') {
            timer = setTimeout(poll, 3000);
          }
        })
        .catch(() => {
          /* transient; a later poll or reopen will refresh */
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [api]);

  const ui = deriveAgencyUpgradeUi(status);

  return (
    <Card>
      <div className="page-header">
        <div>
          <h2 className="page-title">Agency CLI</h2>
          <p className="page-subtitle">{ui.headline}</p>
        </div>
        {ui.busy && <span className="bootstrap-spinner" aria-hidden />}
      </div>
      {ui.detail && (
        <p
          className={`agency-cli-detail agency-cli-${ui.tone}`}
          role={ui.tone === 'danger' ? 'alert' : 'status'}
        >
          {ui.detail}
        </p>
      )}
    </Card>
  );
}
