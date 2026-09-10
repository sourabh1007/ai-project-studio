import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  CheckIcon,
  CloseIcon,
  DragHandleIcon,
  PauseIcon,
  WarningIcon,
} from './icons.js';
import { Spinner } from './loading.js';
import { classifyStatus, type StatusGlyph } from '../lib/status.js';
import {
  attachDialogFocusOwnership,
  captureFocusTarget,
  type FocusTargetSnapshot,
} from '../lib/focus-ownership.js';

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<FocusTargetSnapshot | null>(null);
  const restoreFocusCapturedRef = useRef(false);
  const titleId = useId();
  if (!restoreFocusCapturedRef.current) {
    restoreFocusRef.current = captureFocusTarget();
    restoreFocusCapturedRef.current = true;
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return undefined;
    }
    return attachDialogFocusOwnership(dialog, {
      restoreFocus: restoreFocusRef.current,
    });
  }, []);

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title" id={titleId}>{title}</h2>
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

/**
 * Layered icon container that gives an icon premium visual weight: a gradient
 * or accent-tinted rounded tile, optional glow, and a hover lift. Use `tone`
 * to signal intent — `ai` renders the purple→blue gradient reserved for
 * AI-native features; `accent`/`success`/`neutral` tint from theme tokens.
 */
export function IconBadge({
  icon,
  tone = 'accent',
  size = 'md',
  glow = false,
  className,
}: {
  icon: ReactNode;
  tone?: 'ai' | 'accent' | 'success' | 'neutral';
  size?: 'sm' | 'md' | 'lg' | 'hero';
  glow?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`icon-badge icon-badge-${tone} icon-badge-${size} ${
        glow ? 'is-glow' : ''
      } ${className ?? ''}`.trim()}
      aria-hidden="true"
    >
      {icon}
    </span>
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
  loading = false,
  type = 'button',
  title,
  ariaLabel,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  /** Show an inline spinner and block interaction while an action runs. */
  loading?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  ariaLabel?: string;
  /** Extra classes appended after the canonical `btn btn-<variant>`. */
  className?: string;
}) {
  return (
    <button
      type={type}
      className={`btn btn-${variant}${loading ? ' is-loading' : ''}${
        className ? ` ${className}` : ''
      }`}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
    >
      {loading && <Spinner size={14} label="Working" />}
      <span className="btn-label">{children}</span>
    </button>
  );
}

/** Renders the leading glyph for a status: an animated/steady dot or an icon. */
function StatusGlyphNode({
  glyph,
  animated,
}: {
  glyph: StatusGlyph;
  animated: boolean;
}) {
  if (glyph === 'check') {
    return <CheckIcon />;
  }
  if (glyph === 'cross') {
    return <CloseIcon />;
  }
  if (glyph === 'warn') {
    return <WarningIcon />;
  }
  if (glyph === 'pause') {
    return <PauseIcon />;
  }
  // spinner / dot / circle all render as a tone-coloured dot; only the running
  // spinner pulses. This is the single scannable "state light" for the app.
  return (
    <span
      className={`status-badge-dot${animated ? ' is-animated' : ''}`}
      aria-hidden="true"
    />
  );
}

/**
 * The one canonical status indicator for the whole app. Give it any status
 * string ("running", "in_progress", "done", "failed", …) and it resolves to a
 * fixed semantic tone + glyph via {@link classifyStatus}, so the same state
 * always looks the same everywhere: blue+animated for running, green for
 * success, red for failure, amber for warning, slate for pending/paused. Shows
 * a readable label by default so users scan colour first, text second; pass
 * `showLabel={false}` for a compact dot-only indicator in tight rows.
 */
export function StatusBadge({
  status,
  label,
  showLabel = true,
  className,
}: {
  status: string;
  /** Override the auto-derived label text. */
  label?: string;
  /** Hide the text and render a compact dot/icon only. */
  showLabel?: boolean;
  className?: string;
}) {
  const { tone, glyph, animated, label: derived } = classifyStatus(status);
  const text = label ?? derived;
  return (
    <span
      className={`status-badge status-tone-${tone}${
        animated ? ' is-animated' : ''
      }${showLabel ? '' : ' is-compact'} ${className ?? ''}`.trim()}
      role="img"
      aria-label={text}
      title={text}
    >
      <span className="status-badge-glyph" aria-hidden="true">
        <StatusGlyphNode glyph={glyph} animated={animated} />
      </span>
      {showLabel ? (
        <span className="status-badge-label">{text}</span>
      ) : (
        <span className="sr-only">{text}</span>
      )}
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
  return <p className="error-text" role="alert">{error}</p>;
}

/**
 * The grip affordance on a draggable row.
 *
 * Dragging was previously invisible: a row could be dragged, but nothing said
 * so, and the only way to find out was to try. The handle sits inside the
 * draggable row, so grabbing it drags exactly what it labels.
 */
export function DragHandle({ label }: { label: string }) {
  return (
    <span
      className="drag-handle"
      title={label}
      aria-label={label}
      role="img"
    >
      <DragHandleIcon size={14} />
    </span>
  );
}

/**
 * A focused confirmation dialog for destructive actions. Renders a warning
 * icon, a headline, a body message, and Cancel / Confirm buttons. The confirm
 * button is styled as a danger action by default.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  icon,
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  icon?: ReactNode;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="confirm-dialog">
        {icon ? (
          <span
            className={`confirm-dialog-icon ${danger ? 'is-danger' : ''}`.trim()}
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
        <div className="confirm-dialog-body">{message}</div>
        <div className="confirm-dialog-actions">
          <Button variant="ghost" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
