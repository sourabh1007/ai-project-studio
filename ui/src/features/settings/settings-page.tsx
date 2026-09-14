import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from 'react';
import { Card, IconBadge } from '../../components/ui.js';
import { ChevronIcon, SearchIcon } from '../../components/icons.js';
import { usePersistentState } from '../../hooks/use-persistent-state.js';

/**
 * The active per-page search term (already trimmed and lower-cased), shared
 * with every {@link CollapsibleCard} on the page so a section can hide itself
 * when it does not match and expand itself when it does. Empty string means
 * "no active search", which restores each card's remembered collapse state.
 */
const SettingsSearchContext = createContext<string>('');

/** True when `query` is empty (no search) or `haystack` contains it. Pure. */
export function sectionMatches(query: string, haystack: string): boolean {
  return query === '' || haystack.includes(query);
}

export interface SettingsPageProps {
  /** Placeholder/aria label for the page search box. */
  searchLabel?: string;
  children: ReactNode;
}

/**
 * Wraps a settings tab in a live search box. The typed term is provided to any
 * {@link CollapsibleCard} descendants via context: matching cards stay visible
 * and force-expand, non-matching cards drop out, so a page with many modules
 * collapses to just the settings a person is looking for.
 */
export function SettingsPage({ searchLabel, children }: SettingsPageProps) {
  const [query, setQuery] = useState('');
  const label = searchLabel ?? 'Search settings on this page…';
  const trimmed = query.trim().toLowerCase();
  return (
    <div className="settings-panel">
      <div className="settings-page-search">
        <SearchIcon size={15} className="settings-page-search-icon" />
        <input
          className="input settings-page-search-input"
          type="search"
          placeholder={label}
          aria-label={label}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query !== '' && (
          <button
            type="button"
            className="settings-page-search-clear"
            onClick={() => setQuery('')}
          >
            Clear
          </button>
        )}
      </div>
      <SettingsSearchContext.Provider value={trimmed}>
        {children}
      </SettingsSearchContext.Provider>
    </div>
  );
}

export interface CollapsibleCardProps {
  /** Stable id; remembers the open/closed state across launches. */
  id: string;
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  tone?: 'ai' | 'accent' | 'success' | 'neutral';
  /** Header controls rendered outside the collapse toggle (kept clickable). */
  actions?: ReactNode;
  /** Extra words a page search should match beyond the title/subtitle. */
  keywords?: string[];
  /** Whether the section starts expanded the first time it is seen. */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * A settings section rendered as a card with a collapsible body. The header is
 * a toggle (chevron animates); the remembered state persists per {@link id}.
 * While a page search is active the card force-expands when it matches and is
 * removed entirely when it does not, so search doubles as a page filter.
 */
export function CollapsibleCard({
  id,
  title,
  subtitle,
  icon,
  tone = 'neutral',
  actions,
  keywords,
  defaultOpen = true,
  children,
}: CollapsibleCardProps) {
  const query = useContext(SettingsSearchContext);
  const [open, setOpen] = usePersistentState<boolean>(
    `cw-settings-open:${id}`,
    defaultOpen,
  );
  const haystack = `${title} ${subtitle ?? ''} ${(keywords ?? []).join(' ')}`
    .toLowerCase();
  if (!sectionMatches(query, haystack)) {
    return null;
  }
  const searching = query !== '';
  const expanded = searching || open;
  return (
    <Card className="settings-collapsible">
      <div className="settings-collapsible-head">
        <button
          type="button"
          className="settings-collapsible-toggle"
          aria-expanded={expanded}
          onClick={() => setOpen(!open)}
        >
          <ChevronIcon size={14} open={expanded} className="settings-collapsible-caret" />
          {icon && <IconBadge icon={icon} tone={tone} />}
          <span className="settings-collapsible-heading">
            <span className="page-title">{title}</span>
            {subtitle && <span className="page-subtitle">{subtitle}</span>}
          </span>
        </button>
        {actions && <div className="settings-collapsible-actions">{actions}</div>}
      </div>
      {expanded && <div className="settings-collapsible-body">{children}</div>}
    </Card>
  );
}
