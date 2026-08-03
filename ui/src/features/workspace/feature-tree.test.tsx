import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Session, TreeGroup } from '../../lib/types.js';
import {
  FeatureTree,
  NodeDragStoreProvider,
  orderedChildren,
} from './feature-tree.js';

function session(overrides: Partial<Session> & { id: string }): Session {
  return {
    featureId: 'f1',
    name: null,
    provider: 'copilot',
    requestedModel: 'gpt-5.4',
    resolvedModel: null,
    status: 'created',
    kind: 'dev',
    prompt: 'p',
    usageFilePath: '/tmp/u',
    createdAt: '2025-01-01T00:00:00Z',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    groupId: null,
    orderIndex: 0,
    ...overrides,
  };
}

function group(overrides: Partial<TreeGroup> & { id: string }): TreeGroup {
  return {
    featureId: 'f1',
    parentGroupId: null,
    kind: 'subcategory',
    name: 'Group',
    prNumber: null,
    prUrl: null,
    orderIndex: 0,
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function noop() {
  /* intentionally empty */
}

function renderTree(props: {
  groups: TreeGroup[];
  sessions: Session[];
  onMove?: (input: unknown) => void;
}) {
  const ordinals = new Map(props.sessions.map((s, i) => [s.id, i + 1]));
  return render(
    <FeatureTree
      featureId="f1"
      groups={props.groups}
      sessions={props.sessions}
      ordinals={ordinals}
      onMove={props.onMove ?? noop}
      onAddSubcategory={noop}
      onAttachPr={noop}
      onRenameGroup={noop}
      onDeleteGroup={noop}
      renderSession={(s) => <div data-testid={`row-${s.id}`}>{s.id}</div>}
    />,
  );
}

describe('orderedChildren', () => {
  it('interleaves and sorts groups and sessions by order, then createdAt', () => {
    const groups = [
      group({ id: 'g1', orderIndex: 2 }),
      group({ id: 'g2', parentGroupId: 'g1', orderIndex: 0 }),
    ];
    const sessions = [
      session({ id: 's1', orderIndex: 1 }),
      session({ id: 's2', orderIndex: 1, createdAt: '2025-01-02T00:00:00Z' }),
      session({ id: 's3', groupId: 'g1', orderIndex: 0 }),
    ];
    const root = orderedChildren(groups, sessions, null);
    expect(root.map((c) => c.group?.id ?? c.session?.id)).toEqual([
      's1',
      's2',
      'g1',
    ]);
    const inside = orderedChildren(groups, sessions, 'g1');
    expect(inside.map((c) => c.group?.id ?? c.session?.id)).toEqual([
      'g2',
      's3',
    ]);
  });

  it('treats a missing orderIndex as zero', () => {
    const sessions = [
      session({ id: 's1', orderIndex: undefined }),
      session({ id: 's2', orderIndex: 5 }),
    ];
    const root = orderedChildren([], sessions, null);
    expect(root[0].session?.id).toBe('s1');
  });
});

describe('FeatureTree', () => {
  it('renders sessions and nested group labels', () => {
    renderTree({
      groups: [group({ id: 'g1', name: 'Docs' })],
      sessions: [session({ id: 's1' }), session({ id: 's2', groupId: 'g1' })],
    });
    expect(screen.getByTestId('row-s1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Docs' })).toBeInTheDocument();
    expect(screen.getByTestId('row-s2')).toBeInTheDocument();
  });

  it('renders a PR group as a link to the pull request', () => {
    renderTree({
      groups: [
        group({
          id: 'g1',
          kind: 'pr',
          name: 'Fix bug',
          prNumber: 42,
          prUrl: 'https://github.com/o/r/pull/42',
        }),
      ],
      sessions: [],
    });
    const link = screen.getByRole('link', { name: /#42 Fix bug/ });
    expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/42');
  });

  it('moves a dragged session into a target index via drop slots', () => {
    const onMove = vi.fn();
    renderTree({
      groups: [],
      sessions: [
        session({ id: 's1', orderIndex: 0 }),
        session({ id: 's2', orderIndex: 1 }),
      ],
      onMove,
    });
    const draggable = screen.getByTestId('row-s1').parentElement as HTMLElement;
    fireEvent.dragStart(draggable);
    // Drop slots only render while a drag is active.
    const slots = document.querySelectorAll('.tree-drop-slot');
    expect(slots.length).toBeGreaterThan(0);
    const last = slots[slots.length - 1];
    fireEvent.dragOver(last);
    fireEvent.drop(last);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session', id: 's1', targetFeatureId: 'f1' }),
    );
  });

  it('moves a node into a group when dropped on its header', () => {
    const onMove = vi.fn();
    renderTree({
      groups: [group({ id: 'g1', name: 'Docs' })],
      sessions: [session({ id: 's1' })],
      onMove,
    });
    const draggable = screen.getByTestId('row-s1').parentElement as HTMLElement;
    fireEvent.dragStart(draggable);
    const header = screen
      .getByRole('button', { name: 'Docs' })
      .closest('.tree-group-header') as HTMLElement;
    fireEvent.dragOver(header);
    fireEvent.drop(header);
    expect(onMove).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session',
        id: 's1',
        targetParentGroupId: 'g1',
      }),
    );
  });

  it('carries a drag across trees when a shared drag store wraps them', () => {
    const onMoveA = vi.fn();
    const onMoveB = vi.fn();
    render(
      <NodeDragStoreProvider>
        <FeatureTree
          featureId="fA"
          groups={[]}
          sessions={[session({ id: 'sa', featureId: 'fA', orderIndex: 0 })]}
          ordinals={new Map([['sa', 1]])}
          onMove={onMoveA}
          onAddSubcategory={noop}
          onAttachPr={noop}
          onRenameGroup={noop}
          onDeleteGroup={noop}
          renderSession={(s) => <div data-testid={`row-${s.id}`}>{s.id}</div>}
        />
        <FeatureTree
          featureId="fB"
          groups={[]}
          sessions={[session({ id: 'sb', featureId: 'fB', orderIndex: 0 })]}
          ordinals={new Map([['sb', 1]])}
          onMove={onMoveB}
          onAddSubcategory={noop}
          onAttachPr={noop}
          onRenameGroup={noop}
          onDeleteGroup={noop}
          renderSession={(s) => <div data-testid={`row-${s.id}`}>{s.id}</div>}
        />
      </NodeDragStoreProvider>,
    );
    const draggable = screen.getByTestId('row-sa').parentElement as HTMLElement;
    fireEvent.dragStart(draggable);
    // Because the drag store is shared, the second tree also renders drop slots.
    const slots = document.querySelectorAll('.tree-drop-slot');
    expect(slots.length).toBeGreaterThan(1);
    const last = slots[slots.length - 1];
    fireEvent.dragOver(last);
    fireEvent.drop(last);
    expect(onMoveB).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session', id: 'sa', targetFeatureId: 'fB' }),
    );
    expect(onMoveA).not.toHaveBeenCalled();
  });
});
