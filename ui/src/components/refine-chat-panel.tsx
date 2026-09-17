import { useState } from 'react';
import { Button, ErrorText } from './ui.js';
import { AiChatIcon, ChevronIcon, SendIcon } from './icons.js';
import { renderMarkdownComment } from '../lib/markdown.js';
import { ApiError } from '../lib/api.js';
import type { RefineChatMessage } from '../lib/types.js';

/**
 * A conversational "refine" panel: the user challenges or asks to edit an
 * already-generated artifact (Bug Bash scenarios or the New Task plan) in plain
 * language. The panel owns the chat transcript and drives one stateless turn at
 * a time via {@link RefineChatPanelProps.onSend}; when a turn returns a revised
 * run, {@link RefineChatPanelProps.onRevised} lets the host swap it in.
 *
 * It is deliberately artifact-agnostic — both agents reuse it by passing their
 * own `onSend` (bound to `api.refineBugBash` / `api.refineNewTask`) and their
 * own labels — so there is exactly one chat implementation to maintain.
 */
export interface RefineChatPanelProps<TRun> {
  /** Heading shown at the top of the panel. */
  title: string;
  /** A short line describing what the user is refining (e.g. the feature). */
  context: string;
  /** Placeholder + empty-state prompt tailored to the artifact. */
  hint: string;
  /** Placeholder text for the message input. */
  placeholder: string;
  /** Runs one refine turn; resolves to the assistant reply and updated run. */
  onSend: (
    history: RefineChatMessage[],
    message: string,
  ) => Promise<{ reply: string; run: TRun }>;
  /** Called with the run whenever a turn revised the artifact. */
  onRevised: (run: TRun) => void;
  /** Whether the panel starts expanded. Defaults to collapsed. */
  defaultOpen?: boolean;
}

export function RefineChatPanel<TRun>({
  title,
  context,
  hint,
  placeholder,
  onSend,
  onRevised,
  defaultOpen = false,
}: RefineChatPanelProps<TRun>) {
  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<RefineChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const content = input.trim();
    if (content.length === 0 || pending) return;
    const next: RefineChatMessage[] = [...messages, { role: 'user', content }];
    setMessages(next);
    setInput('');
    setPending(true);
    setError(null);
    try {
      const result = await onSend(messages, content);
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.reply },
      ]);
      onRevised(result.run);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'The refine agent is unavailable.',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <section className="refine-chat" aria-label={title}>
      <button
        type="button"
        className="refine-chat-toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
      >
        <AiChatIcon size={16} />
        <span className="refine-chat-title">{title}</span>
        <ChevronIcon size={16} open={open} />
      </button>
      {open && (
        <div className="refine-chat-body">
          <p className="refine-chat-context muted">{context}</p>
          <div className="refine-chat-thread">
            {messages.length === 0 && !pending && (
              <p className="refine-chat-hint muted">{hint}</p>
            )}
            {messages.map((m, i) =>
              m.role === 'assistant' ? (
                <div
                  key={i}
                  className="refine-chat-msg refine-chat-assistant cg-chat-md"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdownComment(m.content),
                  }}
                />
              ) : (
                <div key={i} className="refine-chat-msg refine-chat-user">
                  {m.content}
                </div>
              ),
            )}
            {pending && (
              <div className="refine-chat-msg refine-chat-assistant">…</div>
            )}
          </div>
          {error && <ErrorText error={error} />}
          <form
            className="refine-chat-form"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              className="refine-chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              disabled={pending}
            />
            <Button
              variant="primary"
              type="submit"
              disabled={pending || input.trim().length === 0}
            >
              <SendIcon size={14} />
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
