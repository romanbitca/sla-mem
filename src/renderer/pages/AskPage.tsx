import { useCallback, useEffect, useLayoutEffect, useRef, useState, type UIEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import clsx from 'clsx';
import type { MessageDTO } from '../../shared/types';
import { AI_MODEL_INFO } from '../lib/aiModels';
import {
  askQuestion,
  isAnswering,
  NO_SCOPE,
  setAskScope,
  startNewChat,
  stopAnswer,
  useAskChat,
  type AskDraftState,
} from '../lib/askChat';
import { useDirectory, type Directory } from '../lib/directory';
import { formatShortDate } from '../lib/format';
import { isModalOpen, isTypingTarget, useKeydown, useMediaQuery, useStableCallback } from '../lib/hooks';
import { messagePath } from '../lib/links';
import { useSettings } from '../lib/queries';
import { messageKey, parsePreview, withoutPreview, withPreview, type FromSearchState } from '../lib/searchNav';
import { tsToDate } from '../lib/ts';
import { AskTurnView } from '../components/ask/AskTurnView';
import type { CitationResolver } from '../components/ask/AnswerText';
import { Composer } from '../components/ask/Composer';
import { ScopeBar } from '../components/ask/ScopeBar';
import { conversationTitle } from '../components/conversation/ConversationIcon';
import { KeyIcon, PlusIcon, SparklesIcon } from '../components/icons';
import { SidebarToggle } from '../components/layout/shell';
import { resolveAuthor } from '../components/message/author';
import type { ResultLink } from '../components/search/SearchResults';
import { SearchPreview } from '../components/search/SearchPreview';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';

/** Wide enough for the chat and a cited message side by side (as on the search screen). */
const SPLIT_QUERY = '(min-width: 1200px)';

const EXAMPLES = [
  'Find the message where someone asked me to run the tests',
  'What happened in my channels this week?',
  'What did I promise to do in the last two weeks?',
];

// Kept while the window is open, like the chat itself: leaving to read a cited message and coming
// back finds the half-typed question and the place in the chat as they were.
let savedDraft = '';
let savedScroll: { chatId: string; top: number; atBottom: boolean } | null = null;

/**
 * `/ask`: a chat with Claude about the archive. Claude searches and reads the archive with its
 * tools and answers with numbered citations. As on the search screen, a cited message opens beside
 * the chat in wide windows (the preview, in the URL: `c`, `ts`, `thread`) or opens its
 * conversation, whose "Ask AI" button comes back here.
 */
export default function AskPage() {
  const settings = useSettings();
  const chat = useAskChat();
  const location = useLocation();
  const navigate = useNavigate();
  const dir = useDirectory();
  const split = useMediaQuery(SPLIT_QUERY);
  const preview = split ? parsePreview(location.search) : null;
  const previewOpen = preview != null;
  const selectedKey = preview?.ts ? `${preview.conversationId}:${preview.ts}` : null;
  const currentUrl = `/ask${location.search}`;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(savedScroll?.chatId === chat.id ? savedScroll.atBottom : true);
  const [draft, setDraftState] = useState(savedDraft);
  const setDraft = useCallback((value: string) => {
    savedDraft = value;
    setDraftState(value);
  }, []);

  const noKey = settings.data != null && !settings.data.ai.saved;
  const model = settings.data?.preferences.aiModel;
  const answering = isAnswering(chat);
  const empty = chat.turns.length === 0;

  // The first cited message opened adds a history entry (Back closes it); switching replaces it.
  const linkFor = useCallback(
    (message: MessageDTO): ResultLink =>
      split
        ? { to: { pathname: '/ask', search: withPreview(location.search, message) }, replace: previewOpen }
        : {
            to: messagePath(message),
            state: { fromSearch: currentUrl, hit: messageKey(message) } satisfies FromSearchState,
          },
    [split, location.search, previewOpen, currentUrl],
  );
  const citation = useCallback<CitationResolver>(
    (ref) => {
      const message = chat.sources.get(ref);
      return message ? { link: linkFor(message), title: describeSource(message, dir) } : null;
    },
    [chat.sources, linkFor, dir],
  );

  const closePreview = useStableCallback(() =>
    navigate({ pathname: '/ask', search: withoutPreview(location.search) }, { replace: true }),
  );

  const send = () => {
    if (!askQuestion(draft)) return;
    setDraft('');
    stickToBottom.current = true;
  };

  const retry = useStableCallback((question: string) => {
    stickToBottom.current = true;
    askQuestion(question);
  });

  const newChat = () => {
    startNewChat();
    savedScroll = null;
    stickToBottom.current = true;
    if (previewOpen) closePreview();
    inputRef.current?.focus();
  };

  // Esc closes the open message (a thread in it closes first, by its own Esc).
  useKeydown((e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !preview || preview.threadTs || isModalOpen()) return;
    if (isTypingTarget(e.target)) return;
    e.preventDefault();
    closePreview();
  });

  // Coming back to the chat: where it was. Otherwise new text keeps the newest in view, unless
  // the reader has scrolled up to read.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    else if (savedScroll?.chatId === chat.id) el.scrollTop = savedScroll.top;
  }, [chat]);

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickToBottom.current = atBottom;
    savedScroll = { chatId: chat.id, top: el.scrollTop, atBottom };
  };

  // The cursor waits in the box, unless a message is open beside the chat.
  useEffect(() => {
    if (!previewOpen && !noKey) inputRef.current?.focus();
  }, [previewOpen, noKey]);

  // A question handed over by another screen (a person's "Brief me"): into the box, not sent. A
  // fresh chat asks about the whole archive; one under way keeps its limits (they show below).
  const handedDraft = (location.state as Partial<AskDraftState> | null)?.askDraft;
  useEffect(() => {
    if (typeof handedDraft !== 'string' || !handedDraft.trim()) return;
    if (empty) setAskScope(NO_SCOPE);
    setDraft(handedDraft);
    // Once: Back, Forward or a reload must not put it back.
    navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
    inputRef.current?.focus();
  }, [handedDraft, empty, setDraft, navigate, location.pathname, location.search]);

  let body;
  if (noKey && empty) {
    body = (
      <EmptyState
        icon={<KeyIcon size={20} />}
        title="Add your Anthropic API key to ask"
        description="Ask AI uses Claude, by Anthropic, with your own API key: you pay Anthropic only for what you ask, and each answer shows what it cost."
        action={
          <Link
            to="/settings#ask-ai"
            className="focus-ring inline-flex h-8.5 items-center gap-2 rounded-lg border border-transparent bg-accent px-3.5 text-sm font-medium text-accent-ink shadow-xs hover:bg-accent-hover"
          >
            Open Settings
          </Link>
        }
      />
    );
  } else if (empty) {
    body = (
      <div className="mx-auto flex max-w-xl animate-page-in flex-col items-center px-6 pt-[10vh] pb-6 text-center">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-accent-soft text-accent-text">
          <SparklesIcon size={22} />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-ink">Ask about your Slack history</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">
          Claude searches your archive, reads what it finds and answers with links to the messages.
        </p>
        <ul className="mt-6 flex w-full flex-col gap-2" aria-label="Examples">
          {EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                onClick={() => {
                  setDraft(example);
                  inputRef.current?.focus();
                }}
                className="focus-ring w-full rounded-xl border border-line bg-raised px-3.5 py-2.5 text-left text-[13.5px] text-ink-muted shadow-xs transition-colors hover:bg-hover hover:text-ink"
              >
                {example}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        {chat.turns.map((turn) => (
          <AskTurnView
            key={turn.id}
            turn={turn}
            sources={chat.sources}
            citation={citation}
            linkFor={linkFor}
            selectedKey={selectedKey}
            onRetry={() => retry(turn.question)}
          />
        ))}
      </div>
    );
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 animate-page-in flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
        <SidebarToggle />
        <h1 className="text-[15px] font-semibold text-ink">Ask AI</h1>
        {model && !noKey && (
          <Link
            to="/settings#ask-ai"
            title="Choose the model in Settings"
            className="focus-ring truncate rounded text-xs text-ink-faint hover:text-ink-muted"
          >
            {AI_MODEL_INFO[model].name}
          </Link>
        )}
        <Button
          size="sm"
          variant="ghost"
          icon={<PlusIcon size={14} />}
          onClick={newChat}
          disabled={empty}
          title="Start again: this chat is forgotten"
          className="ml-auto"
        >
          New chat
        </Button>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className={clsx('flex min-h-0 flex-col', preview ? 'w-[440px] shrink-0 xl:w-[520px]' : 'flex-1')}>
          <div ref={scrollerRef} onScroll={onScroll} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
            <div className={clsx('mx-auto px-4 py-6 sm:px-6', preview ? 'max-w-none' : 'max-w-3xl')}>{body}</div>
          </div>
          {!(noKey && empty) && (
            <div className={clsx('shrink-0 px-4 pb-4 sm:px-6', preview ? '' : 'mx-auto w-full max-w-3xl')}>
              {noKey ? (
                <p className="rounded-xl border border-line bg-inset px-3.5 py-2.5 text-[13px] text-ink-muted">
                  The API key was removed.{' '}
                  <Link to="/settings#ask-ai" className="font-medium text-accent-text hover:underline">
                    Add one in Settings
                  </Link>{' '}
                  to ask more.
                </p>
              ) : (
                <>
                  <Composer
                    value={draft}
                    onChange={setDraft}
                    onSend={send}
                    onStop={stopAnswer}
                    answering={answering}
                    inputRef={inputRef}
                  />
                  <div className="mt-2">
                    <ScopeBar scope={chat.scope} onChange={setAskScope} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
        {preview && (
          <SearchPreview target={preview} searchUrl={currentUrl} onClose={closePreview} label="Cited message" />
        )}
      </div>
    </section>
  );
}

/** A citation's tooltip: "Ana Pop in #eng-tests, 14 Mar". */
function describeSource(message: MessageDTO, dir: Directory): string {
  const author = resolveAuthor(message, dir).label;
  const conversation = dir.conversations.get(message.conversationId);
  const where = conversation ? conversationTitle(conversation) : message.conversationId;
  return `${author} in ${where}, ${formatShortDate(tsToDate(message.ts))}`;
}
