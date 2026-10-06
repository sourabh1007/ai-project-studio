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
 * a time via {@link RefineChatPanelProps.onSend}.
 *
 * Two apply models are supported:
 * - **Auto-apply (default):** the turn returns an already-updated run and
 *   {@link RefineChatPanelProps.onRevised} swaps it in immediately.
 * - **Consent (opt-in):** when {@link RefineChatPanelProps.onApply} is provided,
 *   a turn's proposed edit is NOT applied automatically. The proposal is shown
 *   under the reply with Apply / Discard; only on Apply is `onApply` called and
 *   its resulting run handed to `onRevised`.
 *
 * It is deliberately artifact-agnostic — both agents reuse it by passing their
 * own `onSend` (bound to `api.refineBugBash` / `api.refineNewTask`) and their
 * own labels — so there is exactly one chat implementation to maintain.
 */
export interface RefineChatPanelProps<TRun, TProposal = unknown> {
  /** Heading shown at the top of the panel. */
  title: string;
  /** A short line describing what the user is refining (e.g. the feature). */
  context: string;
  /** Placeholder + empty-state prompt tailored to the artifact. */
  hint: string;
  /** Placeholder text for the message input. */
  placeholder: string;
  /**
   * Runs one refine turn; resolves to the assistant reply and updated run. When
   * the host opts into consent mode, the turn may also carry a `proposal` — the
   * proposed edit that awaits the user's Apply.
   */
  onSend: (
    history: RefineChatMessage[],
    message: string,
  ) => Promise<{ reply: string; run: TRun; proposal?: TProposal | null }>;
  /** Called with the run whenever the artifact is applied/revised. */
  onRevised: (run: TRun) => void;
  /**
   * Opt into consent mode: when set, a turn's `proposal` is held for the user to
   * Apply or Discard instead of being applied automatically. Called on Apply and
   * must persist the change, resolving to the updated run (passed to onRevised).
   */
  onApply?: (proposal: TProposal) => Promise<TRun>;
  /** Whether the panel starts expanded. Defaults to collapsed. */
  defaultOpen?: boolean;
}

/** A proposed edit awaiting the user's consent, tied to one assistant message. */
interface PendingProposal<TProposal> {
  proposal: TProposal;
  status: 'pending' | 'applying' | 'applied' | 'discarded';
  error: string | null;
}

export function RefineChatPanel<TRun, TProposal = unknown>({
  title,
  context,
  hint,
  placeholder,
  onSend,
  onRevised,
  onApply,
  defaultOpen = false,
}: RefineChatPanelProps<TRun, TProposal>) {
  const [open, setOpen] = useState(defaultOpen);
  const [messages, setMessages] = useState<RefineChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // In consent mode, proposed edits awaiting Apply/Discard, keyed by the index
  // of the assistant message that carries them.
  const [proposals, setProposals] = useState<
    Record<number, PendingProposal<TProposal>>
  >({});

  const applyProposal = async (index: number) => {
    const entry = proposals[index];
    if (
      !entry ||
      !onApply ||
      entry.status === 'applying' ||
      entry.status === 'applied'
    )
      return;
    setProposals((p) => ({
      ...p,
      [index]: { ...entry, status: 'applying', error: null },
    }));
    try {
      const run = await onApply(entry.proposal);
      setProposals((p) => ({
        ...p,
        [index]: { ...p[index], status: 'applied', error: null },
      }));
      onRevised(run);
    } catch (err) {
      setProposals((p) => ({
        ...p,
        [index]: {
          ...p[index],
          status: 'pending',
          error:
            err instanceof ApiError
              ? err.message
              : 'Could not apply the change.',
        },
      }));
    }
  };

  const discardProposal = (index: number) => {
    setProposals((p) =>
      p[index] ? { ...p, [index]: { ...p[index], status: 'discarded', error: null } } : p,
    );
  };

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
      const assistantIndex = next.length;
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: result.reply },
      ]);
      if (onApply) {
        // Consent mode: hold a proposed edit for Apply/Discard; apply nothing
        // automatically. A turn that only answered carries no proposal.
        if (result.proposal != null) {
          setProposals((p) => ({
            ...p,
            [assistantIndex]: {
              proposal: result.proposal as TProposal,
              status: 'pending',
              error: null,
            },
          }));
        }
      } else {
        onRevised(result.run);
      }
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
                <div key={i} className="refine-chat-assistant-row">
                  <div
                    className="refine-chat-msg refine-chat-assistant cg-chat-md"
                    dangerouslySetInnerHTML={{
                      __html: renderMarkdownComment(m.content),
                    }}
                  />
                  {proposals[i] && (
                    <div
                      className={`refine-chat-proposal refine-chat-proposal-${proposals[i].status}`}
                    >
                      {proposals[i].status === 'applied' ? (
                        <span className="refine-chat-proposal-note">
                          ✓ Applied to the plan.
                        </span>
                      ) : proposals[i].status === 'discarded' ? (
                        <span className="refine-chat-proposal-note muted">
                          Change discarded — the plan is unchanged.
                        </span>
                      ) : (
                        <>
                          <span className="refine-chat-proposal-note">
                            The planner proposed a revised plan.
                          </span>
                          <div className="refine-chat-proposal-actions">
                            <Button
                              variant="primary"
                              onClick={() => void applyProposal(i)}
                              loading={proposals[i].status === 'applying'}
                              disabled={proposals[i].status === 'applying'}
                            >
                              Apply to plan
                            </Button>
                            <Button
                              variant="secondary"
                              onClick={() => discardProposal(i)}
                              disabled={proposals[i].status === 'applying'}
                            >
                              Discard
                            </Button>
                          </div>
                          {proposals[i].error && (
                            <ErrorText error={proposals[i].error!} />
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
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
