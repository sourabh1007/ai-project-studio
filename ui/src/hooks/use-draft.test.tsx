import { act, fireEvent, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { useDraft } from './use-draft.js';

/**
 * Mimics SharedContextPanel: `base` starts '' (document still loading) and then
 * becomes the fetched content after an async load — the exact sequence that
 * regressed the workspace-context editor (empty textarea despite loaded data).
 */
function Panel({
  draftKey,
  loaded,
}: {
  draftKey: string;
  loaded: string;
}) {
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDoc(loaded), 0);
    return () => clearTimeout(t);
  }, [loaded]);
  const base = doc ?? '';
  const { value, setValue, isDirty } = useDraft(draftKey, base);
  return (
    <div>
      <textarea
        data-testid="editor"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <span data-testid="dirty">{String(isDirty)}</span>
    </div>
  );
}

describe('useDraft', () => {
  beforeEach(() => window.localStorage.clear());

  it('adopts a base that arrives asynchronously after mount', async () => {
    window.localStorage.setItem('ctx', 'null');
    const { getByTestId } = render(<Panel draftKey="ctx" loaded="LOADED" />);
    expect((getByTestId('editor') as HTMLTextAreaElement).value).toBe('');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect((getByTestId('editor') as HTMLTextAreaElement).value).toBe('LOADED');
    expect(getByTestId('dirty').textContent).toBe('false');
  });

  it('preserves in-progress edits when the base changes afterwards', async () => {
    const { getByTestId } = render(<Panel draftKey="ctx2" loaded="LOADED" />);
    const editor = getByTestId('editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'my edit' } });
    expect(editor.value).toBe('my edit');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    // The async base ('LOADED') must not clobber the user's unsaved text.
    expect(editor.value).toBe('my edit');
    expect(getByTestId('dirty').textContent).toBe('true');
  });
});
