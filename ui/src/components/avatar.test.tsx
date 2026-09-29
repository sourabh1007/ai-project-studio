import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Avatar, initialsOf } from './avatar.js';

describe('initialsOf', () => {
  it('returns a placeholder for empty names', () => {
    expect(initialsOf(null)).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  it('takes the first two letters of a single-word name', () => {
    expect(initialsOf('octocat')).toBe('OC');
  });

  it('combines the first and last parts of a multi-word name', () => {
    expect(initialsOf('Ada Lovelace')).toBe('AL');
    expect(initialsOf('mona.the.octocat')).toBe('MO');
  });
});

describe('Avatar', () => {
  it('renders the provider image when a URL is supplied', () => {
    render(<Avatar name="Ada" avatarUrl="https://example/ada.png" />);
    const img = screen.getByRole('img', { name: 'Ada' });
    expect(img).toHaveAttribute('src', 'https://example/ada.png');
  });

  it('falls back to initials when no URL is given', () => {
    render(<Avatar name="Ada Lovelace" />);
    expect(screen.getByText('AL')).toBeInTheDocument();
  });

  it('falls back to initials after the image fails to load', () => {
    render(<Avatar name="Bob" avatarUrl="https://example/broken.png" />);
    fireEvent.error(screen.getByRole('img', { name: 'Bob' }));
    expect(screen.getByText('BO')).toBeInTheDocument();
  });
});
