import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdownComment } from '../../lib/markdown.js';
import { AiChatIcon, CloseIcon, SendIcon } from '../../components/icons.js';
import type {
  ChangeGraphAnnotations,
  ChangeGraphCategory,
  PrReviewChatMessage,
} from '../../lib/types.js';

/** The assistant's reply to a chat turn: prose plus an optional diagram overlay. */
export interface GraphChatReply {
  answer: string;
  annotations?: ChangeGraphAnnotations;
}

/** Sends the running conversation and resolves the assistant's next reply. */
export type GraphChatSend = (
  messages: PrReviewChatMessage[],
) => Promise<GraphChatReply>;

/** Posts `body` as a comment on the PR; resolves `true` when it lands. */
export type FindingCommentSend = (body: string) => Promise<boolean>;

/** The opening question the panel asks on its own so a diagram is explained up front. */
const OVERVIEW_QUESTION =
  'Give me a brief overview of this diagram: which modules changed, roughly how many files, and how they relate.';

function AssistantBubble({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdownComment(content), [content]);
  return (
    <div
      className="cg-chat-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/**
 * A lightweight "explain this diagram" support chat for a change graph. Opening
 * it auto-asks for an overview, then the reviewer can ask free-form follow-up
 * questions. Stateless on the server — the whole running conversation is sent on
 * every turn — so it never mutates the review.
 */
export function GraphChat({
  category,
  onSend,
  onAnnotations,
  onClose,
}: {
  category: ChangeGraphCategory;
  onSend: GraphChatSend;
  /** Receives the diagram overlay from each answer (null when it carries none). */
  onAnnotations?: (annotations: ChangeGraphAnnotations | null) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<PrReviewChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const ask = useMemo(
    () =>
      async (question: string) => {
        const next: PrReviewChatMessage[] = [
          ...messages,
          { role: 'user', content: question },
        ];
        setMessages(next);
        setBusy(true);
        setError(null);
        try {
          const reply = await onSend(next);
          setMessages([...next, { role: 'assistant', content: reply.answer }]);
          onAnnotations?.(reply.annotations ?? null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          // Drop the un-answered question so a retry does not stack duplicates.
          setMessages(messages);
        } finally {
          setBusy(false);
        }
      },
    [messages, onSend, onAnnotations],
  );

  // Auto-ask for an overview exactly once when the panel first opens.
  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void ask(OVERVIEW_QUESTION);
    // ask closes over the initial empty messages, which is what we want here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) {
      return;
    }
    setDraft('');
    void ask(question);
  }

  return (
    <aside
      className="cg-chat"
      role="dialog"
      aria-label={`Explain the ${category} change graph`}
    >
      <header className="cg-chat-head">
        <span className="cg-chat-title">
          <AiChatIcon size={15} /> Explain this diagram
        </span>
        <button
          type="button"
          className="cg-chat-close"
          onClick={onClose}
          aria-label="Close chat"
        >
          <CloseIcon size={15} />
        </button>
      </header>
      <div className="cg-chat-log" ref={listRef}>
        {messages.map((m, i) => (
          <div
            key={i}
            className={`cg-chat-msg cg-chat-msg-${m.role}`}
          >
            {m.role === 'assistant' ? (
              <AssistantBubble content={m.content} />
            ) : (
              <span>{m.content}</span>
            )}
          </div>
        ))}
        {busy && (
          <div className="cg-chat-msg cg-chat-msg-assistant cg-chat-typing">
            <span className="cg-chat-dot" />
            <span className="cg-chat-dot" />
            <span className="cg-chat-dot" />
          </div>
        )}
        {error && <div className="cg-chat-error">{error}</div>}
      </div>
      <form className="cg-chat-input" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          placeholder="Ask about this diagram…"
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          aria-label="Ask a question about this diagram"
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          aria-label="Send"
        >
          <SendIcon size={15} />
        </button>
      </form>
    </aside>
  );
}

/** The opening ask so a finding is explained the moment its chat opens. */
function seedQuestion(filePath: string, finding: string): string {
  return (
    `A code review flagged the following about \`${filePath}\`:\n\n` +
    `"${finding}"\n\n` +
    `Explain what this means and why it matters, concisely.`
  );
}

/**
 * A focused discussion for a single review finding. The reviewer can challenge
 * or clarify it (free-form Q&A), ask the AI to propose a concrete fix, or post
 * the finding straight onto the pull request as a comment. Stateless on the
 * server like {@link GraphChat} — the whole conversation is resent every turn.
 */
export function FindingChat({
  finding,
  filePath,
  category,
  onSend,
  onComment,
  onClose,
}: {
  finding: string;
  filePath: string;
  category: ChangeGraphCategory;
  onSend: GraphChatSend;
  /** Posts the finding as a PR comment; omit to hide the action. */
  onComment?: FindingCommentSend;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<PrReviewChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);

  const ask = useMemo(
    () =>
      async (question: string) => {
        const next: PrReviewChatMessage[] = [
          ...messages,
          { role: 'user', content: question },
        ];
        setMessages(next);
        setBusy(true);
        setError(null);
        try {
          const reply = await onSend(next);
          setMessages([...next, { role: 'assistant', content: reply.answer }]);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setMessages(messages);
        } finally {
          setBusy(false);
        }
      },
    [messages, onSend],
  );

  useEffect(() => {
    if (started.current) {
      return;
    }
    started.current = true;
    void ask(seedQuestion(filePath, finding));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const question = draft.trim();
    if (!question || busy) {
      return;
    }
    setDraft('');
    void ask(question);
  }

  async function comment() {
    if (!onComment || posting) {
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const ok = await onComment(finding);
      setPosted(ok);
      if (!ok) {
        setError('Could not post the comment on the pull request.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPosting(false);
    }
  }

  return (
    <aside
      className="cg-chat cg-finding-chat"
      role="dialog"
      aria-label={`Discuss finding in ${category} review`}
    >
      <header className="cg-chat-head">
        <span className="cg-chat-title">
          <AiChatIcon size={15} /> Discuss finding
        </span>
        <button
          type="button"
          className="cg-chat-close"
          onClick={onClose}
          aria-label="Close discussion"
        >
          <CloseIcon size={15} />
        </button>
      </header>
      <div className="cg-chat-log" ref={listRef}>
        {messages.map((m, i) => (
          <div key={i} className={`cg-chat-msg cg-chat-msg-${m.role}`}>
            {m.role === 'assistant' ? (
              <AssistantBubble content={m.content} />
            ) : (
              <span>{m.content}</span>
            )}
          </div>
        ))}
        {busy && (
          <div className="cg-chat-msg cg-chat-msg-assistant cg-chat-typing">
            <span className="cg-chat-dot" />
            <span className="cg-chat-dot" />
            <span className="cg-chat-dot" />
          </div>
        )}
        {error && <div className="cg-chat-error">{error}</div>}
      </div>
      <div className="cg-finding-actions">
        <button
          type="button"
          className="cg-finding-action"
          onClick={() =>
            void ask(
              'Propose a concrete fix for this. Show the minimal code change ' +
                'needed to address it.',
            )
          }
          disabled={busy}
        >
          Ask AI to fix
        </button>
        {onComment && (
          <button
            type="button"
            className="cg-finding-action"
            onClick={() => void comment()}
            disabled={posting || posted}
          >
            {posted ? '✓ Commented on PR' : posting ? 'Posting…' : 'Comment on PR'}
          </button>
        )}
      </div>
      <form className="cg-chat-input" onSubmit={submit}>
        <input
          type="text"
          value={draft}
          placeholder="Challenge or ask about this finding…"
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
          aria-label="Ask a question about this finding"
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          aria-label="Send"
        >
          <SendIcon size={15} />
        </button>
      </form>
    </aside>
  );
}