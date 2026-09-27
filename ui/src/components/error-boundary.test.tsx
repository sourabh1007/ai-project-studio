import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './error-boundary.js';

function Broken({ message }: { message: string }): never {
  throw new TypeError(message);
}

afterEach(() => vi.restoreAllMocks());

describe('interface load recovery', () => {
  it('offers a user-controlled page reload rather than retrying a cached failed import', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    render(
      <ErrorBoundary label="Review Board" reloadPage={reload}>
        <Broken message="Failed to fetch dynamically imported module: /assets/old.js" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Interface could not load in Review Board');
    expect(screen.getByRole('alert')).toHaveTextContent('Save any unsent input');
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload app' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary render failures on the existing reset path', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Broken message="Invalid view state" /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload app' })).toBeNull();
  });
});
