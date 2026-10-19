import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PaneResizer } from './pane-resizer.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(overrides: Partial<React.ComponentProps<typeof PaneResizer>> = {}) {
  const onChange = vi.fn();
  const view = render(<PaneResizer label="Resize pane" className="test-resizer"
    value={300} min={200} max={560} resetValue={260} onChange={onChange} {...overrides} />);
  return { ...view, onChange, separator: screen.getByRole('separator') };
}

it('exposes its current size and supports keyboard resizing, limits and reset', () => {
  const { separator, onChange } = mount();
  expect(separator).toHaveAttribute('tabindex', '0');
  expect(separator).toHaveAttribute('aria-valuenow', '300');
  expect(separator).toHaveAttribute('aria-valuetext', '300 pixels');
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
  fireEvent.keyDown(separator, { key: 'Home' });
  fireEvent.keyDown(separator, { key: 'End' });
  fireEvent.keyDown(separator, { key: 'Enter' });
  fireEvent.doubleClick(separator);
  expect(onChange.mock.calls.flat()).toEqual([310, 260, 200, 560, 260, 260]);
});

it('reverses right-side resizing and uses percentage steps for split panes', () => {
  const { separator, onChange } = mount({
    value: 50, min: 25, max: 75, resetValue: 50, units: 'percent', reverse: true,
  });
  fireEvent.keyDown(separator, { key: 'ArrowRight' });
  fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
  expect(onChange.mock.calls.flat()).toEqual([48, 60]);
});

it.each(['pointerup', 'pointercancel', 'blur', 'unmount'])('cleans up a pointer drag on %s', (finish) => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const { separator, onChange, unmount } = mount({ dragScale: () => 2 });
  fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
  fireEvent.pointerMove(document, { clientX: 140 });
  expect(onChange).toHaveBeenLastCalledWith(320);
  expect(document.body).toHaveClass('is-resizing');
  if (finish === 'unmount') unmount();
  else fireEvent(finish === 'blur' ? window : document, new Event(finish));
  expect(document.body).not.toHaveClass('is-resizing');
  onChange.mockClear();
  fireEvent.pointerMove(document, { clientX: 160 });
  expect(onChange).not.toHaveBeenCalled();
});

it('bounds drag values, reverses history drags, and ignores secondary presses and empty layouts', () => {
  vi.stubGlobal('PointerEvent', MouseEvent);
  const { separator, onChange, rerender } = mount({ reverse: true });
  fireEvent.pointerDown(separator, { button: 2, clientX: 100 });
  fireEvent.pointerMove(document, { clientX: 120 });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
  fireEvent.pointerMove(document, { clientX: 120 });
  expect(onChange).toHaveBeenLastCalledWith(280);
  fireEvent.pointerMove(document, { clientX: -1000 });
  expect(onChange).toHaveBeenLastCalledWith(560);
  fireEvent.pointerUp(document);
  rerender(<PaneResizer label="Resize pane" className="test" value={300} min={200}
    max={560} resetValue={260} onChange={onChange} dragScale={0} />);
  onChange.mockClear();
  fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
  fireEvent.pointerMove(document, { clientX: 120 });
  expect(onChange).not.toHaveBeenCalled();
});
