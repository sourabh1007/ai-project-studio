import { useSyncExternalStore } from 'react';
import {
  dismissOperationNotices,
  getOperationNotices,
  subscribeOperationNotices,
} from '../lib/operation-notices.js';

/** Persistent, dismissible banner for notices that must survive dialogs closing and navigation. */
export function OperationNoticeBanner() {
  const notice = useSyncExternalStore(subscribeOperationNotices, getOperationNotices, getOperationNotices);
  if (notice.message === null) return null;
  return (
    <div className="connection-banner connection-banner--backend-down" role="status" aria-live="polite">
      <span className="connection-banner-dot" aria-hidden="true" />
      <span className="connection-banner-title">{notice.message}</span>
      {notice.count > 1 && <span className="connection-banner-detail">· {notice.count} notices</span>}
      <button type="button" className="connection-banner-action" onClick={dismissOperationNotices}>
        Dismiss
      </button>
    </div>
  );
}
