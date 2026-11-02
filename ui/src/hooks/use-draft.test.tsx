import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { useDraft } from './use-draft.js';
import { SharedContextPanel } from '../features/shared-context/shared-context-panel.js';
import { ApiProvider } from '../app/api-context.js';
import { ApiError, type ApiClient } from '../lib/api.js';
import type { SharedContextDoc } from '../lib/types.js';

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
  it('keeps the editor draft and refreshes the comparison after a save conflict', async () => {
    const saved = { content: 'Saved context', updatedAt: '2026-01-01', updatedBy: 'manual' } as SharedContextDoc;
    const getSharedContext = vi.fn().mockResolvedValueOnce(saved).mockResolvedValue({ ...saved, content: 'Concurrent context' });
    const saveSharedContext = vi.fn().mockRejectedValue(new ApiError(409, 'Context changed'));
    render(<ApiProvider value={{ getSharedContext, saveSharedContext } as unknown as ApiClient}><SharedContextPanel scope="workspace" scopeId="w" title="Shared" /></ApiProvider>);
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved context'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Concurrent context');
    expect(screen.getByRole('textbox')).toHaveValue('My draft');
    expect(screen.getByRole('button', { name: 'Replace latest with draft' })).toBeEnabled();
  });
  it('preserves dirty shared context after a background merge and offers an explicit conflict choice', async () => {
    const doc = (content: string) => ({
      scope: 'workspace', scopeId: 'w', content,
      updatedAt: content, updatedBy: 'manual',
    } as SharedContextDoc);
    const getSharedContext = vi.fn().mockResolvedValueOnce(doc('Saved context')).mockResolvedValue(doc('New curated context'));
    const saveSharedContext = vi.fn().mockImplementation(async (_scope, _id, content) => doc(content));
    const api = { getSharedContext, saveSharedContext } as unknown as ApiClient;
    const panel = (livePhase: 'idle' | 'generating') => <ApiProvider value={api}><SharedContextPanel scope="workspace" scopeId="w" title="Shared" livePhase={livePhase} /></ApiProvider>;
    const view = render(panel('idle'));
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue('Saved context'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My unsaved draft' } });
    view.rerender(panel('generating'));
    view.rerender(panel('idle'));
    await screen.findByText(/Shared context changed in the background/);
    expect(screen.getByRole('textbox')).toHaveValue('My unsaved draft');
    expect(screen.getByRole('button', { name: 'Replace latest with draft' })).toBeEnabled();
    expect(screen.getByText('New curated context')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use latest context' }));
    expect(screen.getByRole('textbox')).toHaveValue('New curated context');
    expect(saveSharedContext).not.toHaveBeenCalled();
  });

  it('does not present a context read failure as a new empty document or permit a blind overwrite', async () => {
    const getSharedContext = vi.fn().mockRejectedValue(new Error('503 context unavailable'));
    render(<ApiProvider value={{ getSharedContext } as unknown as ApiClient}><SharedContextPanel scope="workspace" scopeId="w" title="Shared" /></ApiProvider>);
    await screen.findByText('503 context unavailable');
    expect(screen.getByRole('textbox')).toHaveAttribute('placeholder', expect.stringContaining('could not be loaded'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Local note' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Retry loading context' })).toBeEnabled();
  });
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('reports failed backup without discarding text and clears the warning after storage recovers', () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage full', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useDraft('blocked-backup', ''));
    act(() => result.current.setValue('Keep this prompt'));
    expect(result.current.value).toBe('Keep this prompt');
    expect(result.current.isDirty).toBe(true);
    expect(result.current.persistenceError).toMatch(/save or copy/);
    write.mockRestore();
    act(() => result.current.setValue('Keep this prompt and retry'));
    expect(result.current.persistenceError).toBeNull();
    expect(window.localStorage.getItem('blocked-backup')).toContain('Keep this prompt and retry');
  });

  it('reports unavailable storage without throwing or losing the mounted draft', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Access denied', 'SecurityError');
    });
    const { result } = renderHook(() => useDraft('unavailable-backup', ''));
    act(() => result.current.setValue('Unsaved text'));
    expect(result.current.value).toBe('Unsaved text');
    expect(result.current.persistenceError).toMatch(/backup is unavailable/);
  });

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
