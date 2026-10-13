/**
 * The AI Project Studio brand mark — a self-contained, resolution-independent
 * SVG so it stays crisp at any size and reads on dark, light, or tinted chrome
 * (the gradient tile supplies its own contrast, so it never depends on the
 * surrounding theme). The terminal `>_` prompt signals that the mark is an
 * actionable command surface; the spark denotes the AI assist.
 */
import { useId } from 'react';

export function BrandMark({
  size = 30,
  className,
  title = 'AI Project Studio',
}: {
  size?: number;
  className?: string;
  title?: string;
}) {
  // Unique per instance so multiple marks on a page never share gradient ids.
  const uid = useId().replace(/:/g, '');
  const fill = `bm-fill-${uid}`;
  const sheen = `bm-sheen-${uid}`;
  const glyph = `bm-glyph-${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <defs>
        <linearGradient id={fill} x1="0" y1="0" x2="32" y2="32"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#8B5CF6" />
          <stop offset="0.55" stopColor="#6366F1" />
          <stop offset="1" stopColor="#2F80F8" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="18"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={glyph} x1="6" y1="10" x2="24" y2="22"
          gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#E8EEFF" />
        </linearGradient>
      </defs>

      {/* gradient tile + top sheen + thin premium bevel */}
      <rect x="2" y="2" width="28" height="28" rx="8.5" fill={`url(#${fill})`} />
      <rect x="2" y="2" width="28" height="15" rx="8.5" fill={`url(#${sheen})`} />
      <rect x="2.75" y="2.75" width="26.5" height="26.5" rx="7.9" fill="none"
        stroke="#ffffff" strokeOpacity="0.28" strokeWidth="1" />

      {/* terminal prompt `>_` — the "run a command" cue */}
      <g fill="none" stroke={`url(#${glyph})`} strokeWidth="2.4"
        strokeLinecap="round" strokeLinejoin="round">
        <polyline points="9.5,12 14,16 9.5,20" />
        <line x1="16.5" y1="20.2" x2="22" y2="20.2" />
      </g>

      {/* AI spark accent, top-right */}
      <path
        d="M22.6 7.2c.35 1.6.9 2.15 2.5 2.5-1.6.35-2.15.9-2.5 2.5-.35-1.6-.9-2.15-2.5-2.5 1.6-.35 2.15-.9 2.5-2.5z"
        fill="#ffffff"
      />
    </svg>
  );
}
