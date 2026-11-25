import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ProviderFeatureChecklist } from './provider-feature-checklist.js';

afterEach(cleanup);

it('starts collapsed, compares IDE features and keeps diagnostic prose collapsed separately', () => {
  render(<ProviderFeatureChecklist provider={{ installed: true, automation: {
    supported: false, integrationSupported: false, reason: 'Unverified native policy.',
  } }} />);
  const summary = screen.getByText('IDE feature readiness');
  expect(summary.closest('details')).not.toHaveAttribute('open');
  fireEvent.click(summary);
  expect(screen.getAllByRole('img', { name: 'Available' })).toHaveLength(5);
  expect(screen.getAllByRole('img', { name: 'Studio integration required' })).toHaveLength(5);
  expect(screen.queryByRole('img', { name: 'Unavailable' })).not.toBeInTheDocument();
  const review = screen.getByText('AI Review Board');
  expect(within(review.closest('li')!).getByRole('img', { name: 'Studio integration required' })).toHaveStyle({ color: 'var(--warning)' });
  expect(screen.getByText('Troubleshooting').closest('details')).not.toHaveAttribute('open');
});

it('distinguishes missing Claude setup from unsupported native features and renders future states', () => {
  const view = render(<ProviderFeatureChecklist provider={{ installed: false }} />);
  expect(screen.getAllByRole('img', { name: 'Setup required' })).toHaveLength(6);
  expect(screen.queryByRole('img', { name: 'Unavailable' })).not.toBeInTheDocument();
  view.rerender(<ProviderFeatureChecklist provider={{ installed: true, features: [
    { id: 'future', label: 'Future feature', status: 'unsupported', reason: 'No adapter' },
    { id: 'pending', label: 'Pending feature', status: 'checking', reason: 'Checking' },
  ] }} />);
  expect(screen.getByRole('img', { name: 'Unavailable' })).toHaveAttribute('title', 'No adapter');
  expect(screen.getByRole('img', { name: 'Checking' })).toBeInTheDocument();
});
