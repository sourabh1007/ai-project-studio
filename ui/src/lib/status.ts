/**
 * The single source of truth for how an arbitrary status string maps to a
 * canonical, scannable visual state. Before this, every feature invented its
 * own status vocabulary (badge-running was amber, pr-step "generating" was
 * blue, "done"/"ready"/"finished"/"succeeded" all meant success), so the same
 * state looked different — and sometimes contradictory — screen to screen.
 *
 * Kept pure and DOM-free so it can be unit-tested to 100% and reused by the
 * `StatusBadge` primitive and any feature that needs to classify a state.
 *
 * Semantic colour map (never overloaded):
 *   running  → accent (blue), animated  · work is actively happening
 *   success  → green                     · finished well
 *   failed   → red                       · finished badly / errored
 *   warning  → amber                     · needs attention but not failed
 *   pending  → slate, steady dot         · queued / waiting / scheduled
 *   paused   → slate, hollow             · intentionally halted / idle
 *   disabled → muted, dimmed             · turned off / unavailable
 *   neutral  → muted                     · anything unclassified
 */

/** The canonical visual tones a status can resolve to. */
export type StatusTone =
  | 'running'
  | 'success'
  | 'failed'
  | 'warning'
  | 'pending'
  | 'paused'
  | 'disabled'
  | 'neutral';

/** The glyph family a tone renders — a small, fixed icon set. */
export type StatusGlyph =
  | 'spinner'
  | 'check'
  | 'cross'
  | 'warn'
  | 'dot'
  | 'pause'
  | 'circle';

/** A fully-resolved, render-ready description of a status. */
export interface StatusDescriptor {
  /** The canonical tone (drives colour + animation). */
  tone: StatusTone;
  /** Whether the indicator should animate (only running does). */
  animated: boolean;
  /** Which glyph to draw. */
  glyph: StatusGlyph;
  /** A Title-Cased, human-friendly label for the state. */
  label: string;
}

/**
 * Synonym groups. Every raw value the app uses in the wild is normalised (lower,
 * trimmed, spaces/underscores/hyphens collapsed) and matched against these so
 * that, e.g., "in_progress", "in progress", "generating", "working" and
 * "active" all resolve to the single `running` tone.
 */
const SYNONYMS: ReadonlyArray<{
  tone: StatusTone;
  glyph: StatusGlyph;
  animated: boolean;
  label: string;
  match: readonly string[];
}> = [
  {
    tone: 'running',
    glyph: 'spinner',
    animated: true,
    label: 'Running',
    match: [
      'running',
      'active',
      'generating',
      'in progress',
      'inprogress',
      'working',
      'busy',
      'processing',
      'loading',
      'starting',
      'live',
    ],
  },
  {
    tone: 'success',
    glyph: 'check',
    animated: false,
    label: 'Completed',
    match: [
      'completed',
      'complete',
      'done',
      'ready',
      'finished',
      'succeeded',
      'success',
      'passed',
      'ok',
      'healthy',
      'connected',
      'up to date',
      'uptodate',
    ],
  },
  {
    tone: 'failed',
    glyph: 'cross',
    animated: false,
    label: 'Failed',
    match: ['failed', 'failure', 'error', 'errored', 'broken', 'crashed'],
  },
  {
    tone: 'warning',
    glyph: 'warn',
    animated: false,
    label: 'Warning',
    match: ['warning', 'warn', 'degraded', 'stale', 'attention', 'at risk'],
  },
  {
    tone: 'pending',
    glyph: 'dot',
    animated: false,
    label: 'Pending',
    match: [
      'pending',
      'queued',
      'waiting',
      'scheduled',
      'blocked',
      'checking',
    ],
  },
  {
    tone: 'paused',
    glyph: 'pause',
    animated: false,
    label: 'Paused',
    match: ['paused', 'idle', 'stopped', 'suspended', 'cancelled', 'canceled'],
  },
  {
    tone: 'disabled',
    glyph: 'circle',
    animated: false,
    label: 'Disabled',
    match: ['disabled', 'off', 'inactive', 'unavailable', 'skipped'],
  },
];

/** Collapse whitespace/underscores/hyphens so synonyms match reliably. */
function normalize(status: string): string {
  return status
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

/** Title-Case a raw status for display when it isn't a known synonym. */
function titleCase(status: string): string {
  const clean = normalize(status);
  if (clean.length === 0) {
    return 'Unknown';
  }
  return clean
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Resolve any status string to its canonical {@link StatusDescriptor}. Unknown
 * values fall back to a neutral tone but keep a Title-Cased label so the UI
 * still shows something readable rather than a raw token.
 */
export function classifyStatus(status: string): StatusDescriptor {
  const clean = normalize(status);
  for (const group of SYNONYMS) {
    if (group.match.includes(clean)) {
      return {
        tone: group.tone,
        glyph: group.glyph,
        animated: group.animated,
        label: group.label,
      };
    }
  }
  return {
    tone: 'neutral',
    glyph: 'circle',
    animated: false,
    label: titleCase(status),
  };
}
