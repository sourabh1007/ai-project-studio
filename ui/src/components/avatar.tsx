import { useState } from 'react';

/** Derives up-to-two-letter initials from a display name or login. */
export function initialsOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * A small round avatar for a PR author or comment author. Renders the provider
 * avatar image when a URL is supplied and loads; otherwise (or on load error)
 * falls back to initials on a colour derived from the name, so a face is always
 * shown even when the provider omits an avatar.
 */
export function Avatar({
  name,
  avatarUrl,
  size = 24,
  title,
}: {
  name: string | null | undefined;
  avatarUrl?: string | null;
  size?: number;
  title?: string;
}) {
  const [failed, setFailed] = useState(false);
  const label = title ?? name ?? 'Unknown author';
  const dimension = `${size}px`;
  if (avatarUrl && !failed) {
    return (
      <img
        className="cg-avatar cg-avatar-img"
        src={avatarUrl}
        alt={label}
        title={label}
        width={size}
        height={size}
        style={{ width: dimension, height: dimension }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="cg-avatar cg-avatar-fallback"
      title={label}
      aria-label={label}
      role="img"
      style={{ width: dimension, height: dimension, fontSize: `${Math.round(size * 0.42)}px` }}
    >
      {initialsOf(name)}
    </span>
  );
}
