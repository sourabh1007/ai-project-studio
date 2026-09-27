import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { McpUsageCharts } from './mcp-usage-charts.js';
import type { McpServerBreakdown } from '../lib/types.js';

afterEach(cleanup);
const row = (server: string, calls: number, extra: Partial<McpServerBreakdown> = {}): McpServerBreakdown => ({
  server, calls, inputBytes: 1024, outputBytes: 2048, durationMs: 100, ...extra,
});

it('ranks actual calls, shows share, and keeps unavailable billing distinct from zero', () => {
  render(<McpUsageCharts rows={[
    row('local', 2, { provider: 'copilot', origin: 'configured', nanoAiu: 0, inputTokens: 0, outputTokens: 0 }),
    row('bluebird', 8, { provider: 'agency', origin: 'built-in' }),
  ]} />);
  const ranking = screen.getByRole('list', { name: 'MCP server ranking by calls' });
  expect(within(ranking).getAllByRole('listitem')[0]).toHaveTextContent('bluebird');
  expect(screen.getByText('80.0%')).toBeInTheDocument();
  const table = screen.getByRole('table', { name: 'MCP server I/O' });
  const bluebird = within(table).getByRole('cell', { name: /bluebird/ }).closest('tr')!;
  expect(within(bluebird).getAllByText('Not reported')).toHaveLength(4);
  expect(within(table).getByText('CLI built-in')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'AI credits' }));
  const credits = screen.getByRole('list', { name: 'MCP server ranking by credits' });
  expect(within(credits).getAllByRole('listitem')[0]).toHaveTextContent('local');
  expect(within(credits).getAllByRole('listitem')[0]).toHaveTextContent('0.00 AIC');
  fireEvent.click(screen.getByRole('button', { name: 'Tokens' }));
  expect(screen.getByRole('list', { name: 'MCP server ranking by tokens' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Traffic' }));
  expect(screen.getByRole('list', { name: 'MCP server ranking by bytes' })).toBeInTheDocument();
});

it('shows reported totals and partial attribution without hiding other servers', () => {
  render(<McpUsageCharts rows={[
    row('reported', 1, { nanoAiu: 2e9, credits: 1, inputTokens: 20, outputTokens: 10, attribution: 'partial' }),
    row('unknown', 1),
  ]} />);
  expect(screen.getByText('2.00+')).toBeInTheDocument();
  expect(screen.getByText('AIC (partial)')).toBeInTheDocument();
  expect(screen.getByRole('cell', { name: '2.00 (partial)' })).toBeInTheDocument();
});

it('shows an honest empty state and handles a zero-call inventory without NaN', () => {
  const root = render(<McpUsageCharts rows={[]} />);
  expect(screen.getByText('No MCP activity yet.')).toBeInTheDocument();
  root.rerender(<McpUsageCharts rows={[row('idle', 0)]} />);
  expect(screen.getByText('None recorded')).toBeInTheDocument();
  expect(root.container.textContent).not.toMatch(/NaN|Infinity/);
});
