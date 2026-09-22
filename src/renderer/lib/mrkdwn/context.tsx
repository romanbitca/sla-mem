import { createContext, useContext, type FC, type ReactNode } from 'react';

/** What the renderer needs from the app to resolve Slack references. */
export interface MrkdwnContext {
  userLabel(id: string): string | undefined;
  /** Channel name without '#'. Undefined means the channel isn't in the archive (no link). */
  channelLabel(id: string): string | undefined;
  /** Custom workspace emoji URL (or Slack's `alias:name` form), undefined if unknown. */
  customEmojiUrl(name: string): string | undefined;
  /** Build an app link for a channel mention, e.g. `/c/C123`. */
  channelHref(id: string): string;
  /** Optional: an app link for a user mention (their People page); undefined leaves it a chip. */
  userHref?(id: string): string | undefined;
  /** Optional: search terms to highlight (case-insensitive) in text nodes. */
  highlight?: string[];
  /**
   * Optional: client-side navigation for in-app links (channel mentions). When set, plain
   * left-clicks call it instead of doing a full page load; modified clicks keep browser behaviour.
   */
  navigate?(href: string): void;
}

export const defaultMrkdwnContext: MrkdwnContext = {
  userLabel: () => undefined,
  channelLabel: () => undefined,
  customEmojiUrl: () => undefined,
  channelHref: (id) => `/c/${encodeURIComponent(id)}`,
};

const MrkdwnReactContext = createContext<MrkdwnContext>(defaultMrkdwnContext);

export const MrkdwnProvider: FC<{ value: MrkdwnContext; children: ReactNode }> = ({ value, children }) => (
  <MrkdwnReactContext.Provider value={value}>{children}</MrkdwnReactContext.Provider>
);

export function useMrkdwnContext(): MrkdwnContext {
  return useContext(MrkdwnReactContext);
}
