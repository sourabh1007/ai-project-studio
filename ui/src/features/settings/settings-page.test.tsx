import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CollapsibleCard,
  SettingsPage,
  sectionMatches,
} from './settings-page.js';
import { InfoIcon } from '../../components/icons.js';

afterEach(cleanup);

describe('sectionMatches', () => {
  it('always matches an empty query', () => {
    expect(sectionMatches('', 'anything')).toBe(true);
  });
  it('matches when the haystack contains the query', () => {
    expect(sectionMatches('net', 'network activity')).toBe(true);
  });
  it('does not match when the haystack lacks the query', () => {
    expect(sectionMatches('zzz', 'network activity')).toBe(false);
  });
});

describe('CollapsibleCard', () => {
  it('shows the body by default and hides it after collapsing', () => {
    render(
      <CollapsibleCard id="test-open" title="Alpha section">
        <p>Body content</p>
      </CollapsibleCard>,
    );
    expect(screen.getByText('Body content')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /Alpha section/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(toggle);
    expect(screen.queryByText('Body content')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('starts collapsed when defaultOpen is false', () => {
    render(
      <CollapsibleCard id="test-closed" title="Beta section" defaultOpen={false}>
        <p>Hidden body</p>
      </CollapsibleCard>,
    );
    expect(screen.queryByText('Hidden body')).toBeNull();
  });

  it('renders an icon, subtitle, and header actions', () => {
    render(
      <CollapsibleCard
        id="test-rich"
        title="Gamma section"
        subtitle="A helpful subtitle"
        icon={<InfoIcon size={16} />}
        tone="accent"
        actions={<button type="button">Do thing</button>}
      >
        <p>Rich body</p>
      </CollapsibleCard>,
    );
    expect(screen.getByText('A helpful subtitle')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Do thing' })).toBeTruthy();
  });
});

describe('SettingsPage search', () => {
  function twoCards() {
    return (
      <SettingsPage searchLabel="Search test page…">
        <CollapsibleCard id="page-net" title="Network activity">
          <p>Network body</p>
        </CollapsibleCard>
        <CollapsibleCard
          id="page-logs"
          title="Diagnostics"
          keywords={['logs', 'crash']}
        >
          <p>Diagnostics body</p>
        </CollapsibleCard>
      </SettingsPage>
    );
  }

  it('filters sections by title and keywords, then restores them on clear', () => {
    render(twoCards());
    expect(screen.getByText('Network body')).toBeTruthy();
    expect(screen.getByText('Diagnostics body')).toBeTruthy();

    const search = screen.getByLabelText('Search test page…');
    fireEvent.change(search, { target: { value: 'crash' } });
    expect(screen.queryByText('Network body')).toBeNull();
    expect(screen.getByText('Diagnostics body')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Network body')).toBeTruthy();
    expect(screen.getByText('Diagnostics body')).toBeTruthy();
  });

  it('force-expands a collapsed section that matches the active search', () => {
    render(
      <SettingsPage>
        <CollapsibleCard id="page-force" title="Metasession" defaultOpen={false}>
          <p>Metasession body</p>
        </CollapsibleCard>
      </SettingsPage>,
    );
    expect(screen.queryByText('Metasession body')).toBeNull();
    const search = screen.getByLabelText('Search settings on this page…');
    fireEvent.change(search, { target: { value: 'meta' } });
    expect(screen.getByText('Metasession body')).toBeTruthy();
  });
});
