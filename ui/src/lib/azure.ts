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
  /** The project, when the input was a repo URL. */
  project: string | null;
  /** The repository, when the input was a repo URL. */
  repo: string | null;
  /** A compact label such as "org" or "org / repo", or '' when nothing parsed. */
  label: string;
}

export const AZURE_ORGANIZATIONS_STORAGE_KEY = 'azureDevOpsConnections';

/** Canonical hosted organization identity, shared by account and repository pickers. */
export function azureOrganization(input: string): string | null {
  const raw = input.trim();
  if (/[/.]/.test(raw)) {
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (url.protocol !== 'https:' || (url.hostname !== 'dev.azure.com' && !url.hostname.endsWith('.visualstudio.com'))) return null;
    } catch { return null; }
  }
  const org = describeAzureConnection(raw).org;
  return org && /^[a-z0-9][a-z0-9-]{0,49}$/i.test(org) ? org.toLowerCase() : null;
}

export function parseAzureOrganizations(serialized: string, legacy: string): string[] {
  let saved: unknown;
  try { saved = JSON.parse(serialized); } catch { saved = []; }
  const targets = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === 'string') : [];
  return [...new Set([...targets, legacy].map(azureOrganization).filter((value): value is string => Boolean(value)))];
}

/** Parse a raw org/URL string into its org + repo and a compact display label. */
export function describeAzureConnection(input: string | null | undefined): AzureConnection {
  const raw = (input ?? '').trim();
  if (!raw) {
    return { org: null, project: null, repo: null, label: '' };
  }

  const looksLikeUrl = raw.includes('://') || raw.includes('/') || raw.includes('.');
  if (!looksLikeUrl) {
    return { org: raw, project: null, repo: null, label: raw };
  }

  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return { org: raw, project: null, repo: null, label: raw };
  }

  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  const gitIndex = segments.indexOf('_git');
  const repo = gitIndex >= 0 ? (segments[gitIndex + 1] ?? null) : null;

  let org: string | null;
  let project: string | null = null;
  if (host.endsWith('.visualstudio.com')) {
    org = host.split('.')[0] || null;
    project = gitIndex > 0 ? segments[gitIndex - 1] : gitIndex === 0 ? repo : segments[0] ?? null;
  } else {
    org = segments[0] ?? null;
    project = gitIndex > 1 ? segments[gitIndex - 1] : gitIndex === 1 ? repo : segments[1] ?? null;
  }

  const label = [org, repo].filter(Boolean).join(' / ');
  return { org, project, repo, label };
}
