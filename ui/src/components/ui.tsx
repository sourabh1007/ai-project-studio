import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, CircleIcon, ClockIcon, CloseIcon } from './icons.js';

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal glass"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">{title}</h2>
          <button
            type="button"
            className="tree-action"
            title="Close"
            aria-label="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`glass card ${className ?? ''}`.trim()}>{children}</section>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();
  const mod =
    normalized === 'running'
      ? 'badge-running'
      : normalized === 'completed'
        ? 'badge-completed'
        : normalized === 'failed'
          ? 'badge-failed'
          : '';
  const icon =
    normalized === 'running' ? (
      <ClockIcon />
    ) : normalized === 'completed' ? (
      <CheckIcon />
    ) : normalized === 'failed' ? (
      <CloseIcon />
    ) : (
      <CircleIcon />
    );
  return (
    <span
      className={`badge ${mod}`.trim()}
      title={status}
      role="img"
      aria-label={status}
    >
      <span className="badge-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="sr-only">{status}</span>
    </span>
  );
}

export function EmptyState({
  message,
  title,
  description,
  icon,
  action,
}: {
  /** Shorthand single-line copy; used as the description when no title is set. */
  message?: string;
  /** Optional bold headline for a richer, guided empty state. */
  title?: string;
  /** Optional supporting copy shown under the title. */
  description?: string;
  /** Optional decorative icon shown above the text. */
  icon?: ReactNode;
  /** Optional primary call-to-action button. */
  action?: { label: string; onClick: () => void };
}) {
  const body = description ?? message;
  // Plain shorthand: a single muted line, preserving prior call-site behavior.
  if (!title && !icon && !action) {
    return <p className="muted">{body}</p>;
  }
  return (
    <div className="empty-state" role="note">
      {icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {title ? <p className="empty-state-title">{title}</p> : null}
      {body ? <p className="empty-state-desc">{body}</p> : null}
      {action ? (
        <button
          type="button"
          className="empty-state-action"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return <p className="error-text">{error}</p>;
}
