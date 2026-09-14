import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NetworkActivitySection } from './network-activity-section.js';

afterEach(cleanup);

it('renders the network activity heading by default', () => {
  render(<NetworkActivitySection />);
  expect(screen.getByRole('heading', { name: 'Network activity' })).toBeInTheDocument();
  expect(screen.getByText(/integrations/)).toBeInTheDocument();
});

it('renders the integration inventory without the heading when embedded', () => {
  render(<NetworkActivitySection embedded />);
  expect(screen.queryByRole('heading', { name: 'Network activity' })).toBeNull();
  expect(screen.getByText(/every outbound integration/i)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Credentials & secrets' })).toBeInTheDocument();
});
