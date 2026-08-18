import { fireEvent, render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ChangeGraph } from './change-graph.js';
import type { ChangeGraphStep, ChangeGraphNode } from '../../lib/types.js';

function node(
  o: Partial<ChangeGraphNode> & { path: string; projectId: string },
): ChangeGraphNode {
  return {
    module: 'App',
    category: 'code',
    kind: 'changed',
    changeKind: 'modified',
    diff: '',
    whatItDoes: 'x',
    whatChanged: 'y',
    review: ['z'],
    ...o,
  };
}

const step: ChangeGraphStep = {
  status: 'ready',
  metaSessionId: null,
  usage: null,
  failure: null,
  activity: [],
  generatedAt: null,
  projects: [{ id: 'p', name: 'App', path: null }],
  nodes: [
    node({ path: 'src/A.cs', projectId: 'p' }),
    node({ path: 'src/B.cs', projectId: 'p' }),
  ],
  edges: [{ from: 'src/A.cs', to: 'src/B.cs', calls: [] }],
};

describe('ChangeGraph expand', () => {
  it('expands a collapsed module box to reveal its file nodes on click', () => {
    const { container } = render(<ChangeGraph step={step} category="code" />);
    const box = container.querySelector('.cg-box.cg-box-toggle');
    expect(box).toBeTruthy();
    expect(container.querySelectorAll('.cg-filenode').length).toBe(0);

    fireEvent.pointerDown(box!);
    fireEvent.pointerUp(box!);
    fireEvent.click(box!);

    expect(container.querySelectorAll('.cg-filenode').length).toBeGreaterThan(0);
  });

  it('still expands after a canvas pan has set the panned flag', () => {
    const { container } = render(<ChangeGraph step={step} category="code" />);
    const scroll = container.querySelector('.cg-scroll') as HTMLElement;
    // Simulate a background pan: press, move past the threshold, release.
    fireEvent.pointerDown(scroll, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(scroll, { clientX: 40, clientY: 40 });
    fireEvent.pointerUp(scroll);

    const box = container.querySelector('.cg-box.cg-box-toggle')!;
    fireEvent.pointerDown(box);
    fireEvent.pointerUp(box);
    fireEvent.click(box);

    expect(container.querySelectorAll('.cg-filenode').length).toBeGreaterThan(0);
  });
});
