import type { ReactNode } from 'react';

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
