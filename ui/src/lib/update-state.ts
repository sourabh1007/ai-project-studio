/**
 * Pure, framework-free model for the desktop auto-update feature. The Electron
 * main process (see desktop/update-manager.cjs) pushes state snapshots to the
 * renderer; this module merges them and derives everything the UI needs, so the
 * React components stay thin and this logic is fully unit-tested.
 */

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

/** A state snapshot as sent by the main process (all fields optional/partial). */
export interface UpdateSnapshot {
  status?: UpdateStatus;
  currentVersion?: string | null;
  availableVersion?: string | null;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  releaseNotes?: string | null;
  releaseName?: string | null;
  error?: string | null;
  canAutoInstall?: boolean;
  platform?: string;
  releasePageUrl?: string | null;
}

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string | null;
  availableVersion: string | null;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  releaseNotes: string | null;
  releaseName: string | null;
  error: string | null;
  canAutoInstall: boolean;
  platform: string;
  releasePageUrl: string | null;
}

export function initialUpdateState(): UpdateState {
  return {
    status: 'idle',
    currentVersion: null,
    availableVersion: null,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    releaseNotes: null,
    releaseName: null,
    error: null,
    canAutoInstall: false,
    platform: 'unknown',
    releasePageUrl: null,
  };
}

/** Merges a snapshot from the main process onto the previous state. */
export function mergeUpdateState(
  prev: UpdateState,
  snapshot: UpdateSnapshot | null | undefined,
): UpdateState {
  if (!snapshot) {
    return prev;
  }
  return {
    status: snapshot.status ?? prev.status,
    currentVersion: pick(snapshot.currentVersion, prev.currentVersion),
    availableVersion: pick(snapshot.availableVersion, prev.availableVersion),
    percent: clampPercent(snapshot.percent ?? prev.percent),
    transferred: numberOr(snapshot.transferred, prev.transferred),
    total: numberOr(snapshot.total, prev.total),
    bytesPerSecond: numberOr(snapshot.bytesPerSecond, prev.bytesPerSecond),
    releaseNotes: pick(snapshot.releaseNotes, prev.releaseNotes),
    releaseName: pick(snapshot.releaseName, prev.releaseName),
    error: snapshot.status === 'error' ? snapshot.error ?? prev.error : snapshot.error ?? null,
    canAutoInstall: snapshot.canAutoInstall ?? prev.canAutoInstall,
    platform: snapshot.platform ?? prev.platform,
    releasePageUrl: pick(snapshot.releasePageUrl, prev.releasePageUrl),
  };
}

function pick<T>(next: T | null | undefined, prev: T | null): T | null {
  return next === undefined ? prev : next;
}

function numberOr(next: number | undefined, prev: number): number {
  return typeof next === 'number' && Number.isFinite(next) ? next : prev;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export type UpdateTone = 'info' | 'success' | 'danger';

export interface UpdateUi {
  /** Whether the notification banner should be visible at all. */
  showBanner: boolean;
  headline: string;
  detail: string | null;
  tone: UpdateTone;
  showProgress: boolean;
  progressPercent: number;
  /** Action availability. */
  canCheck: boolean;
  canDownload: boolean;
  canInstall: boolean;
  /** True on platforms where install happens in-app (Windows, signed). */
  autoInstall: boolean;
  /** True while an update operation is in flight (for spinners). */
  busy: boolean;
}

/** Derives all UI-facing flags/labels from the raw update state. */
export function deriveUpdateUi(state: UpdateState): UpdateUi {
  const { status } = state;
  const busy = status === 'checking' || status === 'downloading';
  const hadUpdate = state.availableVersion !== null;
  const showBanner =
    status === 'available' ||
    status === 'downloading' ||
    status === 'downloaded' ||
    (status === 'error' && hadUpdate);

  const tone: UpdateTone =
    status === 'error' ? 'danger' : status === 'downloaded' ? 'success' : 'info';

  const headline = headlineFor(state);
  const detail = detailFor(state);

  return {
    showBanner,
    headline,
    detail,
    tone,
    showProgress: status === 'downloading',
    progressPercent: Math.round(state.percent),
    canCheck: status !== 'checking' && status !== 'downloading',
    canDownload: status === 'available',
    canInstall: status === 'downloaded' || (status === 'available' && !state.canAutoInstall),
    autoInstall: state.canAutoInstall,
    busy,
  };
}

function headlineFor(state: UpdateState): string {
  switch (state.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return state.availableVersion
        ? `Update available — v${state.availableVersion}`
        : 'Update available';
    case 'downloading':
      return `Downloading update… ${Math.round(state.percent)}%`;
    case 'downloaded':
      return state.availableVersion
        ? `Update ready — v${state.availableVersion}`
        : 'Update ready to install';
    case 'not-available':
      return "You're up to date";
    case 'error':
      return 'Update failed';
    default:
      return 'Up to date';
  }
}

function detailFor(state: UpdateState): string | null {
  if (state.status === 'error') {
    return state.error ?? 'Something went wrong while updating.';
  }
  if (state.status === 'downloading' && state.total > 0) {
    return `${formatBytes(state.transferred)} of ${formatBytes(state.total)} · ${formatSpeed(
      state.bytesPerSecond,
    )}`;
  }
  if (state.status === 'available' && !state.canAutoInstall) {
    return 'Downloads the installer — finish the guided install to update.';
  }
  return state.releaseName ?? null;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Human-readable byte size (e.g. 1536 -> "1.5 KB"). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const exponent = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[exponent]}`;
}

/** Download speed label (e.g. "1.2 MB/s"). */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}
