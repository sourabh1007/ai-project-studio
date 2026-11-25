import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionTimeline, HistoryChart, InsightMatrix, Insights } from './insights.js';
import { sharedRead } from './shared-read.js';
import { ReviewInsights, reviewAttentionByPath } from '../review-board-page/review-insights.js';
import type { ReviewBoard } from '../../lib/types.js';

describe('contextual monitoring presentation', () => {
  it('does not mount an expensive insight until requested, and unmounts it when closed', () => {
    const body = vi.fn(() => <p>Measured view</p>);
    const { container } = render(<Insights>{body}</Insights>);
    expect(body).not.toHaveBeenCalled();
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(screen.getByText('Measured view')).toBeInTheDocument();
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(screen.queryByText('Measured view')).not.toBeInTheDocument();
  });
  it('paginates a bounded matrix without dropping subjects or requiring color/hover', () => {
    const select = vi.fn();
    render(<InsightMatrix title="Attention" columns={['Business']} explanation="Not coverage."
      rows={Array.from({ length: 61 }, (_, i) => ({ id: String(i), label: `File ${i}`, cells: [{ value: i, select }] }))} />);
    expect(screen.queryByRole('rowheader', { name: 'File 60' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'File 0, Business: 0' }));
    expect(select).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('rowheader', { name: 'File 60' })).toBeInTheDocument();
  });
  it('preserves missing-sample gaps and offers a keyboard-accessible data table', () => {
    const { container } = render(<HistoryChart title="Host CPU" unit="%" explain="Host only." maxGapMs={10}
      points={[{ id: '1', label: 'a', at: 1, value: 10 }, { id: '2', label: 'b', at: 2, value: null },
        { id: '3', label: 'c', at: 20, value: 5 }, { id: 'bad', label: 'Unknown time', at: NaN, value: 99 }]} />);
    expect(container.querySelector('path')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(container.querySelector('svg')?.innerHTML).not.toContain('NaN');
    fireEvent.click(screen.getByRole('button', { name: 'Data table' }));
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });
  it('does not depict a failed operation without its end boundary as still running', () => {
    render(<ExecutionTimeline now={1000} items={[
      { id: 'failed', label: 'Failed attempt', status: 'failed', start: 10, end: null },
      { id: 'running', label: 'Active attempt', status: 'running', start: 20, end: null },
    ]} />);
    expect(screen.getByText('End boundary unavailable')).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
  });
  it('counts unique groups once per path, keeps unlocated concerns and filters the exact perspective', () => {
    const finding = { id: 'f', perspectiveId: 'business', severity: 'high', evidence: [{ source: 'src/a.ts', location: { path: 'src/a.ts', line: 1 } }] };
    const board = {
      featureId: 'feature', perspectives: [{ id: 'business', name: 'Business', status: 'reviewed', findings: [finding] }],
      uniqueFindings: [{ id: 'g', finding, observations: [finding, finding], perspectiveIds: ['business'], skillIds: [] }],
      run: { id: 'r', revision: 1, context: { skills: [] } },
    } as unknown as ReviewBoard;
    expect(reviewAttentionByPath(board)).toEqual({ 'src/a.ts': 1 });
    const filter = vi.fn();
    render(<ReviewInsights board={board} onFilter={filter} />);
    fireEvent.click(screen.getByRole('button', { name: 'src/a.ts, Business: 1' }));
    expect(filter).toHaveBeenCalledWith({ file: 'src/a.ts', perspective: 'business' });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(2);
  });
  it('shares in-flight reads only for the same API owner and scope, and releases failed reads', async () => {
    const owner = {};
    let resolve!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>((done) => { resolve = done; }));
    const first = sharedRead(owner, 'feature:a', load);
    expect(sharedRead(owner, 'feature:a', load)).toBe(first);
    await Promise.resolve();
    resolve(1);
    expect(await first).toBe(1);
    expect(await sharedRead({}, 'feature:a', async () => 2)).toBe(2);
    await expect(sharedRead(owner, 'failed', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(await sharedRead(owner, 'failed', async () => 3)).toBe(3);
    expect(load).toHaveBeenCalledOnce();
  });
  it('does not cross-attribute a merged group to another observation’s file or skill', () => {
    const security = { id: 's', perspectiveId: 'security', skillIds: ['policy'], evidence: [{ source: 'a.ts', location: { path: 'a.ts', line: 1 } }] };
    const business = { id: 'b', perspectiveId: 'business', skillIds: [], evidence: [{ source: 'b.ts', location: { path: 'b.ts', line: 1 } }] };
    const board = {
      featureId: 'feature', perspectives: [{ id: 'security', name: 'Security', status: 'reviewed', findings: [security] },
        { id: 'business', name: 'Business', status: 'reviewed', findings: [business] }],
      uniqueFindings: [{ id: 'group', finding: security, observations: [security, business], perspectiveIds: ['security', 'business'], skillIds: ['policy'] }],
      run: { id: 'run', context: { skills: [{ id: 'policy', name: 'Policy', source: 'AGENTS.md', fingerprint: 'p' }] } },
      businessMatrix: [{ requirement: { id: 'rule', text: 'Keep data', source: 'request' }, assessment: 'violated', findingIds: ['s', 'b'] }],
    } as unknown as ReviewBoard;
    const filter = vi.fn();
    render(<ReviewInsights board={board} onFilter={filter} />);
    expect(screen.getByRole('button', { name: 'a.ts, Security: 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'a.ts, Business: 0 · reviewed' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Review insight'), { target: { value: 'skills' } });
    expect(screen.getByRole('button', { name: 'Policy · AGENTS.md · p, Business: 0' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Review insight'), { target: { value: 'business' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keep data · request, Linked groups: 1' }));
    expect(filter).toHaveBeenCalledWith({ requirement: 'rule' });
  });
});
