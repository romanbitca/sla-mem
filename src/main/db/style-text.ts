/**
 * Reading and rewriting a message's own words for My style: what counts as a greeting, a small
 * letter where a capital belongs, a missing apostrophe or a casual word, and the same message
 * with those fixed. Rules, not a language model: they run instantly and on this computer only.
 *
 * Text is Slack mrkdwn. Markup (`<@U1>` mentions, `<https://…|links>`, `<#C1|channels>`), code
 * and quotes are never changed or counted.
 */
import { unescapeEntities } from './normalize';

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const QUOTE_LINE = /^(?:>|&gt;).*$/gm;
const MARKUP = /<[^>\n]*>/g;
const EMOJI = /:[a-z0-9_+'-]+:/g;

/** A message's own words: without code, quotes, links, mentions, channel names or emoji. */
export function prose(text: string): string {
  return unescapeEntities(text.replace(CODE, ' ').replace(QUOTE_LINE, ' ').replace(MARKUP, ' ').replace(EMOJI, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Something to read as a sentence (at least one letter). */
export function hasWords(p: string): boolean {
  return /\p{L}/u.test(p);
}

// ─── language ────────────────────────────────────────────────────────────────────────────────

const ENGLISH_WORDS =
  /\b(?:the|and|you|your|is|are|was|to|for|this|that|with|have|has|we|can|could|please|will|would|it|of|in|on|not|be|do|did|does|me|my|i|im|what|how|when|thanks?|thank|yes|no|ok|okay|hi|hello|hey|if|so|but|just|need|let|check|there|here)\b/gi;
const ROMANIAN_WORDS =
  /\b(?:și|si|este|nu|da|că|ca|pe|la|în|sunt|am|ai|azi|mâine|maine|bine|ea|el|eu|tu|voi|noi|mersi|salut|bună|buna|ce|cum|unde|te|rog|putem|facem|aici|acum)\b/gi;
const CYRILLIC_OR_OTHER = /[\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF]/;

/**
 * Written in English, where the checks on capitals, "i", apostrophes and casual words apply.
 * Short messages with no telling words ("Da.", "+1") count as neither.
 */
export function isEnglish(p: string): boolean {
  if (CYRILLIC_OR_OTHER.test(p)) return false;
  const en = p.match(ENGLISH_WORDS)?.length ?? 0;
  const other = p.match(ROMANIAN_WORDS)?.length ?? 0;
  if (other > 0 && other * 2 >= en) return false;
  return en >= 2 || (en === 1 && p.split(/\s+/).length <= 3);
}

// ─── greetings ───────────────────────────────────────────────────────────────────────────────

const GREETING_WORD = String.raw`(?:hi+|hello+|helo|hey+|heya|hiya|howdy|greetings|dear|good\s+(?:morning|afternoon|evening|day)|morning|gm|salut|salutare|buna|bună|ziua|ciao|hola|bonjour|hallo|servus|salam|marhaba|привет|здравствуйте|добрый\s+(?:день|вечер)|доброе\s+утро)`;
/** Opens with a greeting (after mentions and emoji, which prose() has already taken out). */
const GREETING_START = new RegExp(String.raw`^[\s,.!-]*${GREETING_WORD}(?![\p{L}])`, 'iu');
/** Asks after them: "how are you", "hope you are well". */
const WARM =
  /\bhow\s+(?:are|r)\s+(?:you|u)\b|\bhope\s+(?:you(?:['’]re|\s+are)?|u\s+r|all\s+is|everything\s+is|you['’]re)\b|\bhow(?:['’]s|\s+is)\s+(?:it\s+)?going\b|\bhow\s+was\s+your\b|\bce\s+faci\b|\bcum\s+e[șs]ti\b|\bкак\s+(?:дела|ты|вы)\b/i;
/** Nothing but hello and small talk: "Hi, how are you?", "Hello, hope you are well." */
const GREETING_ONLY = new RegExp(
  String.raw`^(?:[\s,.!?:;-]|${GREETING_WORD}|how\s+(?:are|r)\s+(?:you|u)(?:\s+(?:doing|today))?|how(?:['’]s|\s+is)\s+(?:it\s+)?going|hope\s+(?:you(?:['’]re|\s+are)?|u\s+r)\s+(?:well|good|fine|ok|okay|doing\s+(?:well|good|great))|hope\s+all\s+is\s+(?:well|good)|all\s+good|you|there|team|all|everyone|guys|man|mate|again|to\s+all|ce\s+faci|cum\s+e[șs]ti)+$`,
  'iu',
);

export function startsWithGreeting(p: string): boolean {
  return GREETING_START.test(p) || WARM.test(firstSentence(p));
}

export function asksAfterThem(p: string): boolean {
  return WARM.test(p);
}

/** Only a greeting, with nothing to act on: the question is left for another message. */
export function isGreetingOnly(p: string): boolean {
  return hasWords(p) && GREETING_ONLY.test(p);
}

function firstSentence(p: string): string {
  return p.split(/[.!?\n]/, 1)[0] ?? '';
}

// ─── capitals and apostrophes ────────────────────────────────────────────────────────────────

/** Contractions written without the apostrophe, and how they read with it. */
const APOSTROPHES: Record<string, string> = {
  im: "I'm",
  ive: "I've",
  dont: "don't",
  doesnt: "doesn't",
  didnt: "didn't",
  cant: "can't",
  couldnt: "couldn't",
  wont: "won't",
  wouldnt: "wouldn't",
  shouldnt: "shouldn't",
  isnt: "isn't",
  arent: "aren't",
  wasnt: "wasn't",
  werent: "weren't",
  havent: "haven't",
  hasnt: "hasn't",
  hadnt: "hadn't",
  thats: "that's",
  whats: "what's",
  youre: "you're",
  youve: "you've",
  youll: "you'll",
  theyre: "they're",
  theyve: "they've",
  weve: "we've",
  itll: "it'll",
};
const APOSTROPHE_WORD = new RegExp(String.raw`\b(${Object.keys(APOSTROPHES).join('|')})\b`, 'gi');
/** "i" as a word: not "i.e.", not "i-phone". */
const SMALL_I = /(?<![\p{L}\p{N}_'’.@#/-])i(?=$|[\s,.!?;:)'’])(?!\.\p{L})/gu;

/** How many times "i" stands for "I". */
export function smallIs(p: string): number {
  return p.match(SMALL_I)?.length ?? 0;
}

/** Contractions missing their apostrophe, by word ("im", "dont"). */
export function missingApostrophes(p: string): string[] {
  return [...p.matchAll(APOSTROPHE_WORD)].map((m) => m[1].toLowerCase());
}

/** The message starts with a word, and with a small letter ("123 tickets" starts with a number). */
export function startsSmall(p: string): boolean {
  const first = /[\p{L}\p{N}]/u.exec(p);
  return first != null && /\p{Ll}/u.test(first[0]) && !/^[a-z]+[.:/]\S/i.test(p.slice(first.index));
}

// ─── casual words ────────────────────────────────────────────────────────────────────────────

/** Casual words and what a work message would say instead (empty: leave it out). */
const CASUAL: Record<string, string> = {
  yeah: 'yes',
  yeh: 'yes',
  yep: 'yes',
  yup: 'yes',
  nope: 'no',
  nah: 'no',
  gonna: 'going to',
  wanna: 'want to',
  gotta: 'have to',
  dunno: "don't know",
  u: 'you',
  ur: 'your',
  pls: 'please',
  plz: 'please',
  thx: 'thanks',
  tnx: 'thanks',
  cuz: 'because',
  coz: 'because',
  lol: '',
  lmao: '',
  omg: '',
  wtf: '',
};
const CASUAL_WORD = new RegExp(String.raw`\b(${Object.keys(CASUAL).join('|')})\b`, 'gi');
/** Laughs, and "man"/"bro"/"dude" as a way of addressing someone. */
const LAUGH = /\b(?:ha){2,}h*\b|\b(?:he){2,}\b/gi;
const ADDRESS = /\b(?:thanks|thank\s+you|thx|hey|hi|hello|yes|sure|ok|okay|cool)[,!]?\s+(man|bro|dude|mate)\b/gi;
const SWEARING = /\b(?:fuck\w*|shit\w*|bullshit|damn(?:ed|it)?|crap)\b/gi;

/** A casual word the rewrite replaces with another (not one it only leaves out, like a laugh). */
export function isReplaceable(word: string): boolean {
  return Boolean(CASUAL[word]) || ['man', 'bro', 'dude', 'mate'].includes(word);
}

/** The casual words in a message, as written (lowercase). */
export function casualWords(p: string): string[] {
  const out: string[] = [];
  for (const m of p.matchAll(CASUAL_WORD)) {
    // "u" only as "you": not "u.s.", "u-turn" or a list item "u)".
    if (m[1].toLowerCase() === 'u' && /^[.\-)]/.test(p.slice(m.index + 1))) continue;
    out.push(m[1].toLowerCase());
  }
  for (const m of p.matchAll(LAUGH)) out.push(m[0].toLowerCase().startsWith('he') ? 'hehe' : 'haha');
  for (const m of p.matchAll(ADDRESS)) out.push(m[1].toLowerCase());
  for (const m of p.matchAll(SWEARING)) out.push(m[0].toLowerCase());
  return out;
}

// ─── requests ────────────────────────────────────────────────────────────────────────────────

/** "can you …", "will you …": a request that reads better with "could you" and "please". */
const PLAIN_REQUEST = /\b(?:can|will)\s+(?:you|u)\b/i;
const POLITE = /\b(?:please|pls|plz|kindly|thanks|thank\s+you|thx|would\s+you\s+mind|if\s+you\s+(?:can|could))\b/i;

export function isPlainRequest(p: string): boolean {
  return PLAIN_REQUEST.test(p);
}

export function isPolite(p: string): boolean {
  return POLITE.test(p) || /\b(?:could|would)\s+you\b/i.test(p);
}

// ─── rewriting ───────────────────────────────────────────────────────────────────────────────

/** Abbreviations whose dot doesn't end a sentence. */
const ABBREVIATION = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl|min|max|no|nr|fig|mr|mrs|ms|dr|st)|\d)\.$/i;

/**
 * The message with capitals where sentences start, "I" for "i" and apostrophes back in
 * contractions. Markup, code and quotes stay as they are.
 */
export function polish(text: string): string {
  const fixed = mapProse(text, (s) =>
    s.replace(APOSTROPHE_WORD, (w) => withCase(w, APOSTROPHES[w.toLowerCase()])).replace(SMALL_I, 'I'),
  );
  return capitalizeSentences(fixed);
}

/** Casual words replaced, then polished. */
export function withoutCasual(text: string): string {
  const fixed = mapProse(text, (s) =>
    s
      .replace(ADDRESS, (m, who: string) => m.slice(0, m.length - who.length).replace(/[,!]?\s+$/, ''))
      .replace(LAUGH, '')
      .replace(CASUAL_WORD, (w, _g, offset: number, all: string) =>
        w.toLowerCase() === 'u' && /^[.\-)]/.test(all.slice(offset + 1)) ? w : withCase(w, CASUAL[w.toLowerCase()]),
      )
      .replace(/ {2,}/g, ' ')
      .replace(/ ([,.!?])/g, '$1'),
  );
  return polish(fixed)
    .replace(/^[\s,.!]+/, '')
    .trim();
}

/** "can you check this?" → "Could you please check this?" */
export function askPolitely(text: string): string {
  const alreadyPolite = POLITE.test(prose(text));
  let done = false;
  const fixed = mapProse(text, (s) =>
    done
      ? s
      : s.replace(PLAIN_REQUEST, (m) => {
          done = true;
          return withCase(m, alreadyPolite ? 'could you' : 'could you please');
        }),
  );
  return polish(fixed);
}

/** Slack mrkdwn as it reads: names for mentions, labels for links, no emoji codes. */
export function readable(text: string, labels: ReadonlyMap<string, string>): string {
  return unescapeEntities(
    text
      .replace(
        /<@([A-Z0-9]+)(?:\|([^>]*))?>/g,
        (_m, id: string, name?: string) => `@${labels.get(id) ?? name ?? 'someone'}`,
      )
      .replace(/<#[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, name?: string) => `#${name || 'channel'}`)
      .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
      .replace(/<(https?:\/\/[^>]+)>/g, (_m, url: string) => url.replace(/^https?:\/\/(www\.)?/, ''))
      .replace(/<[^>\n]*>/g, '')
      .replace(EMOJI, ''),
  )
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
}

/** A greeting in front: "Hi Dana, can you …". */
export function withGreeting(text: string, name: string | null): string {
  const body = text.trimStart();
  const first = /\p{L}/u.exec(body);
  // "Can you" becomes "can you" after the comma; "I" and names keep their capital.
  const lowered =
    first && /^\p{Lu}\p{Ll}/u.test(body.slice(first.index)) && !/^I\b/.test(body.slice(first.index))
      ? body.slice(0, first.index) + body[first.index].toLowerCase() + body.slice(first.index + 1)
      : body;
  return polish(`Hi${name ? ` ${name}` : ''}, ${lowered}`);
}

/** Several messages sent in a row, as one: each a sentence. */
export function joinMessages(texts: readonly string[]): string {
  return texts
    .map((t) => polish(t.trim()))
    .filter(Boolean)
    .map((t) => (/[.!?:…)]$/.test(t) || /[\p{Emoji_Presentation}]$/u.test(t) ? t : `${t}.`))
    .join(' ');
}

/** Runs `fix` over the words only: markup, code and quotes pass through untouched. */
function mapProse(text: string, fix: (s: string) => string): string {
  const keep = /```[\s\S]*?```|`[^`\n]*`|<[^>\n]*>|^(?:>|&gt;).*$|:[a-z0-9_+'-]+:|&[a-z]+;/gm;
  let out = '';
  let last = 0;
  for (const m of text.matchAll(keep)) {
    out += fix(text.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fix(text.slice(last));
}

/** A capital at the start and after each sentence end; mentions and emoji in front are skipped. */
function capitalizeSentences(text: string): string {
  const chars = [...text];
  let atStart = true;
  // "@Ana can you …": a sentence opening with a mention reads on without a capital.
  let afterMention = false;
  let inMarkup = false;
  let inCode = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === '`') inCode = !inCode;
    if (inCode) continue;
    if (c === '<') {
      inMarkup = true;
      if (atStart && chars[i + 1] === '@') afterMention = true;
    }
    if (inMarkup) {
      if (c === '>') inMarkup = false;
      continue;
    }
    if (/\p{L}/u.test(c)) {
      if (atStart && !afterMention && /\p{Ll}/u.test(c) && !startsAddress(chars, i)) chars[i] = c.toUpperCase();
      atStart = false;
      afterMention = false;
    } else if (/[.!?]/.test(c) && /\s/.test(chars[i + 1] ?? '')) {
      if (c !== '.' || !ABBREVIATION.test(chars.slice(Math.max(0, i - 8), i + 1).join(''))) atStart = true;
    } else if (c === '\n') {
      atStart = true;
    } else if (c === ':' && /[a-z0-9_+'-]/i.test(chars[i + 1] ?? '')) {
      // An emoji code (":smile:"): skip to its end.
      const end = chars.indexOf(':', i + 1);
      if (end > i && /^[a-z0-9_+'-]+$/i.test(chars.slice(i + 1, end).join(''))) i = end;
    }
  }
  return chars.join('');
}

/** "docs.google.com": a word that is an address keeps its case. */
function startsAddress(chars: readonly string[], i: number): boolean {
  const word = chars
    .slice(i, i + 40)
    .join('')
    .split(/\s/, 1)[0];
  return /^[a-z0-9-]+\.[a-z]{2,}/i.test(word);
}

/** The replacement in the original word's case: "Yeah" → "Yes", "DONT" → "DON'T". */
function withCase(original: string, replacement: string): string {
  if (!replacement) return '';
  if (original.length > 1 && original === original.toUpperCase()) return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(original)) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}
