import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons.js';

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
  const mod =
    status === 'running'
      ? 'badge-running'
      : status === 'completed'
        ? 'badge-completed'
        : status === 'failed'
          ? 'badge-failed'
          : '';
  return <span className={`badge ${mod}`.trim()}>{status}</span>;
}

export function EmptyState({ message }: { message: string }) {
  return <p className="muted">{message}</p>;
}

export function ErrorText({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return <p className="error-text">{error}</p>;
}
