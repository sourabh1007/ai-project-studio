/**
 * Turn whatever the user typed into the Azure DevOps sign-in box — a bare org
 * name, an org URL, or a full repository URL — into a short, human-readable
 * label for the "connected to" status pill, mirroring how the GitHub pill shows
 * the signed-in account.
 *
 * Kept pure and dependency-free so the 100% lib coverage gate can exercise every
 * branch. The parsing intentionally mirrors the backend's `parseAzureTarget`
 * (host + org resolution) and additionally recovers the repository name from a
 * `.../_git/<repo>` URL so the pill can read "org / repo".
 */
export interface AzureConnection {
  /** The organization, when it could be resolved. */
  org: string | null;
  /** The repository, when the input was a repo URL. */
  repo: string | null;
  /** A compact label such as "org" or "org / repo", or '' when nothing parsed. */
  label: string;
}

/** Parse a raw org/URL string into its org + repo and a compact display label. */
export function describeAzureConnection(input: string | null | undefined): AzureConnection {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { org: null, repo: null, label: '' };
  }

  const looksLikeUrl = raw.includes('://') || raw.includes('/') || raw.includes('.');
  if (!looksLikeUrl) {
    return { org: raw, repo: null, label: raw };
  }

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { org: raw, repo: null, label: raw };
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const gitIndex = segments.indexOf('_git');
  const repo = gitIndex >= 0 ? (segments[gitIndex + 1] ?? null) : null;

  let org: string | null;
  if (host.endsWith('.visualstudio.com')) {
    org = host.split('.')[0] || null;
  } else {
    org = segments[0] ?? null;
  }

  const label = [org, repo].filter(Boolean).join(' / ');
  return { org, repo, label };
}
