import { describe, expect, it } from 'vitest';
import { parseMrkdwn } from './parse';
import type { CodeChildNode, MrkdwnNode } from './types';

// Tiny AST builders keep expectations readable.
const t = (text: string): MrkdwnNode => ({ type: 'text', text });
const br: MrkdwnNode = { type: 'br' };
const b = (...children: MrkdwnNode[]): MrkdwnNode => ({ type: 'bold', children });
const i = (...children: MrkdwnNode[]): MrkdwnNode => ({ type: 'italic', children });
const s = (...children: MrkdwnNode[]): MrkdwnNode => ({ type: 'strike', children });
const code = (...children: (CodeChildNode | string)[]): MrkdwnNode => ({
  type: 'code',
  children: children.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)),
});
const pre = (...children: (CodeChildNode | string)[]): MrkdwnNode => ({
  type: 'pre',
  children: children.map((c) => (typeof c === 'string' ? { type: 'text', text: c } : c)),
});
const q = (...children: MrkdwnNode[]): MrkdwnNode => ({ type: 'quote', children });
const link = (url: string, label = url): CodeChildNode => ({ type: 'link', url, label });
const emoji = (name: string, skinTone: string | null = null): MrkdwnNode => ({ type: 'emoji', name, skinTone });
const user = (id: string, label: string | null = null): CodeChildNode => ({ type: 'user', id, label });
const channel = (id: string, label: string | null = null): CodeChildNode => ({ type: 'channel', id, label });

const p = parseMrkdwn;

describe('plain text and entities', () => {
  it('returns [] for empty input', () => {
    expect(p('')).toEqual([]);
  });

  it('keeps plain text as a single node', () => {
    expect(p('hello world')).toEqual([t('hello world')]);
  });

  it('unescapes &lt; &gt; &amp; exactly once', () => {
    expect(p('a &lt;b&gt; &amp; c')).toEqual([t('a <b> & c')]);
    expect(p('&amp;lt; is how you write &amp;amp;')).toEqual([t('&lt; is how you write &amp;')]);
  });

  it('leaves other entities and stray ampersands alone', () => {
    expect(p('&quot;x&quot; & y &#39;')).toEqual([t('&quot;x&quot; & y &#39;')]);
  });

  it('keeps a raw < that is not a reference literal', () => {
    expect(p('a < b and c > d')).toEqual([t('a < b and c > d')]);
    expect(p('x <not a ref> y')).toEqual([t('x <not a ref> y')]);
    expect(p('<>')).toEqual([t('<>')]);
  });
});

describe('bold / italic / strike', () => {
  it('parses each marker', () => {
    expect(p('*bold*')).toEqual([b(t('bold'))]);
    expect(p('_italic_')).toEqual([i(t('italic'))]);
    expect(p('~strike~')).toEqual([s(t('strike'))]);
  });

  it('parses several spans on one line', () => {
    expect(p('*a* and _b_ or ~c~')).toEqual([b(t('a')), t(' and '), i(t('b')), t(' or '), s(t('c'))]);
  });

  it('allows spaces inside and single characters', () => {
    expect(p('*two words*')).toEqual([b(t('two words'))]);
    expect(p('*a*')).toEqual([b(t('a'))]);
  });

  it('nests different markers', () => {
    expect(p('*bold _italic_ bold*')).toEqual([b(t('bold '), i(t('italic')), t(' bold'))]);
    expect(p('_*both*_')).toEqual([i(b(t('both')))]);
    expect(p('~_*all three*_~')).toEqual([s(i(b(t('all three'))))]);
    expect(p('*~x~*')).toEqual([b(s(t('x')))]);
  });

  it('does not format inside words (snake_case, arithmetic)', () => {
    expect(p('snake_case_word')).toEqual([t('snake_case_word')]);
    expect(p('2*3*4')).toEqual([t('2*3*4')]);
    expect(p('a~b~c')).toEqual([t('a~b~c')]);
    expect(p('file_name_v2.txt')).toEqual([t('file_name_v2.txt')]);
    expect(p('some_var and other_var')).toEqual([t('some_var and other_var')]);
  });

  it('does not close when the closing marker runs into a word', () => {
    expect(p('*bold*text')).toEqual([t('*bold*text')]);
    expect(p('_it_s')).toEqual([t('_it_s')]);
  });

  it('requires non-space content next to the markers', () => {
    expect(p('* not bold *')).toEqual([t('* not bold *')]);
    expect(p('*not bold *')).toEqual([t('*not bold *')]);
    expect(p('* not bold*')).toEqual([t('* not bold*')]);
    expect(p('2 * 3 * 4')).toEqual([t('2 * 3 * 4')]);
    expect(p('**')).toEqual([t('**')]);
    expect(p('__')).toEqual([t('__')]);
  });

  it('leaves unmatched markers literal', () => {
    expect(p('*bold')).toEqual([t('*bold')]);
    expect(p('bold*')).toEqual([t('bold*')]);
    expect(p('_x')).toEqual([t('_x')]);
    expect(p('costs ~100 or ~200')).toEqual([t('costs ~100 or ~200')]);
  });

  it('pairs with the nearest marker: content never contains its own marker', () => {
    expect(p('*foo *bar*')).toEqual([t('*foo '), b(t('bar'))]);
    expect(p('*a* b*')).toEqual([b(t('a')), t(' b*')]);
  });

  it('does not let different markers cross', () => {
    expect(p('*a _b* c_')).toEqual([b(t('a _b')), t(' c_')]);
  });

  it('renders doubled markers like Slack: one pair formats, the outer ones stay', () => {
    expect(p('**bold**')).toEqual([t('*'), b(t('bold')), t('*')]);
    expect(p('__init__')).toEqual([t('_'), i(t('init')), t('_')]);
  });

  it('accepts punctuation around markers', () => {
    expect(p('(*bold*)')).toEqual([t('('), b(t('bold')), t(')')]);
    expect(p('*bold*.')).toEqual([b(t('bold')), t('.')]);
    expect(p('"_quoted_",')).toEqual([t('"'), i(t('quoted')), t('",')]);
    expect(p('¡*hola*!')).toEqual([t('¡'), b(t('hola')), t('!')]);
    expect(p('x:*y*')).toEqual([t('x:'), b(t('y'))]);
    expect(p('*bold*_')).toEqual([b(t('bold')), t('_')]);
  });

  it('treats letters of any script as word characters', () => {
    expect(p('café*bold*')).toEqual([t('café*bold*')]);
    expect(p('日本語*太字*です')).toEqual([t('日本語*太字*です')]);
    expect(p('日本語 *太字* です')).toEqual([t('日本語 '), b(t('太字')), t(' です')]);
  });

  it('never spans a line break', () => {
    expect(p('*a\nb*')).toEqual([t('*a'), br, t('b*')]);
    expect(p('_one\ntwo_')).toEqual([t('_one'), br, t('two_')]);
  });

  it('formats around entities, mentions and emoji', () => {
    expect(p('*a &amp; b*')).toEqual([b(t('a & b'))]);
    expect(p('*<@U123>*')).toEqual([b(user('U123'))]);
    expect(p('_:smile:_')).toEqual([i(emoji('smile'))]);
    expect(p('*:tada: shipped*')).toEqual([b(emoji('tada'), t(' shipped'))]);
  });
});

describe('inline code', () => {
  it('parses code spans', () => {
    expect(p('run `npm test` now')).toEqual([t('run '), code('npm test'), t(' now')]);
    expect(p('`a` and `b`')).toEqual([code('a'), t(' and '), code('b')]);
  });

  it('keeps formatting, emoji and URLs literal inside', () => {
    expect(p('`*stars* _under_ ~tilde~`')).toEqual([code('*stars* _under_ ~tilde~')]);
    expect(p('`:smile:`')).toEqual([code(':smile:')]);
    expect(p('`https://example.com`')).toEqual([code('https://example.com')]);
  });

  it('unescapes entities inside', () => {
    expect(p('`&lt;div&gt; &amp;&amp;`')).toEqual([code('<div> &&')]);
  });

  it('still resolves Slack references inside (Slack wraps URLs server-side)', () => {
    expect(p('`see <https://x.com|x.com>`')).toEqual([code('see ', link('https://x.com/', 'x.com'))]);
    expect(p('`<@U1>`')).toEqual([code(user('U1'))]);
  });

  it('can sit inside formatting', () => {
    expect(p('*see `x`*')).toEqual([b(t('see '), code('x'))]);
  });

  it('is atomic: formatting cannot start or end inside it', () => {
    expect(p('*a `b* c` d')).toEqual([t('*a '), code('b* c'), t(' d')]);
    expect(p('_x `y_` z_')).toEqual([i(t('x '), code('y_'), t(' z'))]);
  });

  it('ignores empty or blank spans and unmatched backticks', () => {
    expect(p('``')).toEqual([t('``')]);
    expect(p('` `')).toEqual([t('` `')]);
    expect(p('a ` b')).toEqual([t('a ` b')]);
  });

  it('does not span lines', () => {
    expect(p('`a\nb`')).toEqual([t('`a'), br, t('b`')]);
  });
});

describe('pre blocks', () => {
  it('parses a fenced block', () => {
    expect(p('```code```')).toEqual([pre('code')]);
  });

  it('drops the newline right after the opening and before the closing fence', () => {
    expect(p('```\nline 1\nline 2\n```')).toEqual([pre('line 1\nline 2')]);
  });

  it('preserves inner newlines, indentation and blank lines', () => {
    expect(p('```if (x) {\n  y();\n\n}```')).toEqual([pre('if (x) {\n  y();\n\n}')]);
  });

  it('keeps everything literal inside', () => {
    expect(p('```*b* _i_ :smile: > not quote\n&gt; nor this```')).toEqual([
      pre('*b* _i_ :smile: > not quote\n> nor this'),
    ]);
  });

  it('resolves links inside', () => {
    expect(p('```curl <https://api.x.com/v1?a=1&amp;b=2>```')).toEqual([
      pre('curl ', link('https://api.x.com/v1?a=1&b=2')),
    ]);
  });

  it('may start and end mid-line', () => {
    expect(p('before ```code``` after')).toEqual([t('before'), pre('code'), t('after')]);
    expect(p('run:```npm i```')).toEqual([t('run:'), pre('npm i')]);
  });

  it('does not add blank lines around the block', () => {
    expect(p('intro\n```code```\noutro')).toEqual([t('intro'), br, pre('code'), t('outro')]);
    expect(p('intro\n\n```code```\n\noutro')).toEqual([t('intro'), br, br, pre('code'), br, t('outro')]);
  });

  it('treats unclosed or empty fences as text', () => {
    expect(p('```not closed')).toEqual([t('```not closed')]);
    expect(p('``````')).toEqual([t('``````')]);
    expect(p('``` ```')).toEqual([t('``` ```')]);
  });

  it('handles two blocks in a row', () => {
    expect(p('```a```\n```b```')).toEqual([pre('a'), pre('b')]);
  });

  it('keeps formatting from spanning across a block', () => {
    expect(p('*a ```x``` b*')).toEqual([t('*a'), pre('x'), t('b*')]);
  });
});

describe('blockquotes', () => {
  it('parses escaped and raw > quotes', () => {
    expect(p('&gt; quoted')).toEqual([q(t('quoted'))]);
    expect(p('> quoted')).toEqual([q(t('quoted'))]);
    expect(p('&gt;tight')).toEqual([q(t('tight'))]);
  });

  it('strips exactly one space after the marker', () => {
    expect(p('&gt;   indented')).toEqual([q(t('  indented'))]);
  });

  it('merges consecutive quote lines, including empty ones', () => {
    expect(p('&gt; one\n&gt;\n&gt; two')).toEqual([q(t('one'), br, br, t('two'))]);
  });

  it('ends the quote at the first unquoted line without extra blank lines', () => {
    expect(p('before\n&gt; q\nafter')).toEqual([t('before'), br, q(t('q')), t('after')]);
    expect(p('&gt; q\n\nafter')).toEqual([q(t('q')), br, t('after')]);
  });

  it('supports formatting, mentions and code inside', () => {
    expect(p('&gt; *bold* <@U1> `c`')).toEqual([q(b(t('bold')), t(' '), user('U1'), t(' '), code('c'))]);
  });

  it('quotes the rest of the message after >>>', () => {
    expect(p('intro\n&gt;&gt;&gt; all\nof\n\nthis')).toEqual([
      t('intro'),
      br,
      q(t('all'), br, t('of'), br, br, t('this')),
    ]);
    expect(p('&gt;&gt;&gt;\nnext line')).toEqual([q(t('next line'))]);
    expect(p('>>> raw form')).toEqual([q(t('raw form'))]);
  });

  it('does not nest: a second > is text', () => {
    expect(p('&gt;&gt; x')).toEqual([q(t('> x'))]);
    expect(p('&gt;&gt;&gt; a\n&gt; b')).toEqual([q(t('a'), br, t('> b'))]);
  });

  it('only counts > at the start of a line', () => {
    expect(p('a &gt; b')).toEqual([t('a > b')]);
    expect(p(' &gt; not')).toEqual([t(' > not')]);
  });

  it('shows a lone > as text', () => {
    expect(p('&gt;')).toEqual([t('>')]);
    expect(p('&gt;&gt;&gt;')).toEqual([t('>>>')]);
  });

  it('can contain a pre block', () => {
    expect(p('&gt; see ```code```')).toEqual([q(t('see'), pre('code'))]);
  });

  it('keeps > lines inside a pre block literal', () => {
    expect(p('```\n&gt; a\n```')).toEqual([pre('> a')]);
  });
});

describe('lists and line breaks', () => {
  it('keeps list lines as plain text lines', () => {
    expect(p('• one\n• two')).toEqual([t('• one'), br, t('• two')]);
    expect(p('1. first\n2. *second*')).toEqual([t('1. first'), br, t('2. '), b(t('second'))]);
  });

  it('keeps blank lines', () => {
    expect(p('a\n\nb')).toEqual([t('a'), br, br, t('b')]);
  });

  it('normalizes CRLF', () => {
    expect(p('a\r\nb\rc')).toEqual([t('a'), br, t('b'), br, t('c')]);
  });
});

describe('references', () => {
  it('parses user mentions', () => {
    expect(p('<@U123ABC>')).toEqual([user('U123ABC')]);
    expect(p('<@U123|roman>')).toEqual([user('U123', 'roman')]);
    expect(p('<@W123>')).toEqual([user('W123')]);
  });

  it('parses channel mentions', () => {
    expect(p('<#C123>')).toEqual([channel('C123')]);
    expect(p('<#C123|general>')).toEqual([channel('C123', 'general')]);
    expect(p('<#C123|>')).toEqual([channel('C123')]);
  });

  it('rejects malformed ids', () => {
    expect(p('<@>')).toEqual([t('<@>')]);
    expect(p('<#general>')).toEqual([t('<#general>')]);
  });

  it('parses broadcasts', () => {
    expect(p('<!here> <!channel> <!everyone> <!here|here> <!group>')).toEqual([
      { type: 'broadcast', target: 'here' },
      t(' '),
      { type: 'broadcast', target: 'channel' },
      t(' '),
      { type: 'broadcast', target: 'everyone' },
      t(' '),
      { type: 'broadcast', target: 'here' },
      t(' '),
      { type: 'broadcast', target: 'channel' },
    ]);
  });

  it('parses user groups (subteams)', () => {
    expect(p('<!subteam^S0123|@design>')).toEqual([{ type: 'usergroup', id: 'S0123', label: '@design' }]);
    expect(p('<!subteam^S0123>')).toEqual([{ type: 'usergroup', id: 'S0123', label: null }]);
  });

  it('parses dates with fallback, optional link and entity-escaped text', () => {
    expect(p('<!date^1392734382^{date_short} at {time}|Feb 18, 2014 6:39 AM>')).toEqual([
      {
        type: 'date',
        timestamp: 1392734382,
        format: '{date_short} at {time}',
        url: null,
        fallback: 'Feb 18, 2014 6:39 AM',
      },
    ]);
    expect(p('<!date^1392734382^{date}^https://x.com/e|Feb 18 &amp; later>')).toEqual([
      { type: 'date', timestamp: 1392734382, format: '{date}', url: 'https://x.com/e', fallback: 'Feb 18 & later' },
    ]);
  });

  it('drops unsafe date links and shows the fallback for bad timestamps', () => {
    expect(p('<!date^1392734382^{date}^javascript:alert(1)|x>')).toEqual([
      { type: 'date', timestamp: 1392734382, format: '{date}', url: null, fallback: 'x' },
    ]);
    expect(p('<!date^soon^{date}|later>')).toEqual([t('later')]);
  });

  it('shows unknown special commands as their label', () => {
    expect(p('<!foo|bar>')).toEqual([t('bar')]);
    expect(p('<!foo>')).toEqual([t('@foo')]);
  });
});

describe('links', () => {
  it('parses labelled and bare angle links', () => {
    expect(p('<https://example.com|Example>')).toEqual([link('https://example.com/', 'Example')]);
    expect(p('<https://example.com/path>')).toEqual([link('https://example.com/path')]);
    expect(p('<http://x.com|x.com>')).toEqual([link('http://x.com/', 'x.com')]);
  });

  it('shows the URL as written when there is no (or an empty) label', () => {
    expect(p('<https://example.com>')).toEqual([link('https://example.com/', 'https://example.com')]);
    expect(p('<https://example.com|>')).toEqual([link('https://example.com/', 'https://example.com')]);
  });

  it('parses mailto links', () => {
    expect(p('<mailto:a@b.com|a@b.com>')).toEqual([link('mailto:a@b.com', 'a@b.com')]);
    expect(p('<mailto:a@b.com>')).toEqual([link('mailto:a@b.com', 'a@b.com')]);
  });

  it('unescapes entities in URLs and labels once', () => {
    expect(p('<https://x.com/?a=1&amp;b=2|A &amp; B &amp;lt;>')).toEqual([
      link('https://x.com/?a=1&b=2', 'A & B &lt;'),
    ]);
  });

  it('keeps labels literal (no formatting or emoji)', () => {
    expect(p('<https://x.com|*not bold* :smile:>')).toEqual([link('https://x.com/', '*not bold* :smile:')]);
  });

  it('keeps URL characters from being read as formatting', () => {
    expect(p('<https://x.com/a_b_c*d~e>')).toEqual([link('https://x.com/a_b_c*d~e')]);
  });

  it('can be formatted from outside', () => {
    expect(p('*<https://x.com|site>*')).toEqual([b(link('https://x.com/', 'site'))]);
  });

  it('renders non-http(s)/mailto schemes as text, never links', () => {
    expect(p('<javascript:alert(1)|click me>')).toEqual([t('click me')]);
    expect(p('<javascript:alert(1)>')).toEqual([t('javascript:alert(1)')]);
    expect(p('<JavaScript:alert(1)|x>')).toEqual([t('x')]);
    expect(p('<data:text/html,<b>|x>')).toEqual([t('<data:text/html,<b>|x>')]);
    expect(p('<data:text/html;base64,AAAA|x>')).toEqual([t('x')]);
    expect(p('<vbscript:msgbox|x>')).toEqual([t('x')]);
    expect(p('<ftp://files.x.com|ftp>')).toEqual([t('ftp')]);
    expect(p('<slack://open|open slack>')).toEqual([t('open slack')]);
    expect(p('before <javascript:x|y> after')).toEqual([t('before y after')]);
  });

  it('rejects http links without a host', () => {
    expect(p('<https://|x>')).toEqual([t('x')]);
  });
});

describe('bare URLs', () => {
  it('autolinks http(s) URLs in text', () => {
    expect(p('see https://example.com/page now')).toEqual([t('see '), link('https://example.com/page'), t(' now')]);
    expect(p('HTTP://EXAMPLE.COM')).toEqual([link('http://example.com/', 'HTTP://EXAMPLE.COM')]);
  });

  it('drops trailing punctuation', () => {
    expect(p('go to https://x.com.')).toEqual([t('go to '), link('https://x.com/', 'https://x.com'), t('.')]);
    expect(p('https://x.com/a?!')).toEqual([link('https://x.com/a', 'https://x.com/a'), t('?!')]);
    expect(p('"https://x.com/q",')).toEqual([t('"'), link('https://x.com/q'), t('",')]);
  });

  it('keeps balanced parentheses and drops unbalanced ones', () => {
    expect(p('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      t('('),
      link('https://en.wikipedia.org/wiki/Foo_(bar)'),
      t(')'),
    ]);
  });

  it('keeps underscores and stars inside the URL', () => {
    expect(p('https://x.com/a_b_c')).toEqual([link('https://x.com/a_b_c')]);
    expect(p('_https://x.com/a_b_')).toEqual([i(link('https://x.com/a_b'))]);
    expect(p('*https://x.com*')).toEqual([b(link('https://x.com/', 'https://x.com'))]);
  });

  it('unescapes &amp; and stops at &lt; / &gt;', () => {
    expect(p('https://x.com/?a=1&amp;b=2')).toEqual([link('https://x.com/?a=1&b=2')]);
    expect(p('https://x.com/&lt;tag&gt;')).toEqual([link('https://x.com/'), t('<tag>')]);
    expect(p('https://x.com/?a=1&amp;')).toEqual([link('https://x.com/?a=1'), t('&')]);
  });

  it('needs a boundary before and a host after', () => {
    expect(p('xhttps://x.com')).toEqual([t('xhttps://x.com')]);
    expect(p('http:// nothing')).toEqual([t('http:// nothing')]);
    expect(p('https://')).toEqual([t('https://')]);
  });

  it('does not autolink other schemes', () => {
    expect(p('javascript:alert(1)')).toEqual([t('javascript:alert(1)')]);
    expect(p('ftp://x.com')).toEqual([t('ftp://x.com')]);
  });
});

describe('emoji', () => {
  it('parses shortcodes', () => {
    expect(p(':smile:')).toEqual([emoji('smile')]);
    expect(p('hi :wave: there')).toEqual([t('hi '), emoji('wave'), t(' there')]);
    expect(p(':+1: :-1: :100:')).toEqual([emoji('+1'), t(' '), emoji('-1'), t(' '), emoji('100')]);
  });

  it('keeps underscores in names away from italics', () => {
    expect(p(':white_check_mark: done')).toEqual([emoji('white_check_mark'), t(' done')]);
    expect(p('_:white_check_mark: done_')).toEqual([i(emoji('white_check_mark'), t(' done'))]);
  });

  it('attaches skin tones', () => {
    expect(p(':+1::skin-tone-3:')).toEqual([emoji('+1', '3')]);
    expect(p(':wave::skin-tone-6: hi')).toEqual([emoji('wave', '6'), t(' hi')]);
    expect(p(':handshake::skin-tone-2-4:')).toEqual([emoji('handshake', '2-4')]);
    expect(p(':skin-tone-2:')).toEqual([emoji('skin-tone-2')]);
    expect(p(':+1::skin-tone-9:')).toEqual([emoji('+1'), emoji('skin-tone-9')]);
  });

  it('parses adjacent emoji and emoji glued to text', () => {
    expect(p(':smile::smile:')).toEqual([emoji('smile'), emoji('smile')]);
    expect(p('done:tada:')).toEqual([t('done'), emoji('tada')]);
  });

  it('parses custom-looking names (unknown ones render as text later)', () => {
    expect(p(':party-parrot:')).toEqual([emoji('party-parrot')]);
    expect(p('10:30:45')).toEqual([t('10'), emoji('30'), t('45')]);
  });

  it('ignores things that are not shortcodes', () => {
    expect(p(':Smile:')).toEqual([t(':Smile:')]);
    expect(p('a: b: c')).toEqual([t('a: b: c')]);
    expect(p('::')).toEqual([t('::')]);
    expect(p(':no spaces:')).toEqual([t(':no spaces:')]);
    expect(p(':a:b:')).toEqual([emoji('a'), t('b:')]);
  });
});

describe('mixed real-world messages', () => {
  it('parses a typical deploy notification', () => {
    const text =
      '*Deploy* `api@1.2.3` to <https://prod.x.com|prod> by <@U1> :rocket:\n&gt; _all checks passed_ (<#C2|ops>)';
    expect(p(text)).toEqual([
      b(t('Deploy')),
      t(' '),
      code('api@1.2.3'),
      t(' to '),
      link('https://prod.x.com/', 'prod'),
      t(' by '),
      user('U1'),
      t(' '),
      emoji('rocket'),
      br,
      q(i(t('all checks passed')), t(' ('), channel('C2', 'ops'), t(')')),
    ]);
  });

  it('does not mutate or share nodes between parses', () => {
    const a = p('*x* y');
    const b2 = p('*x* y');
    expect(a).toEqual(b2);
    expect(a[0]).not.toBe(b2[0]);
  });
});

describe('performance', () => {
  const time = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it('parses ~200KB of mixed mrkdwn in under 100ms', () => {
    const chunk =
      '*bold* _it_ ~s~ `code` <https://x.com/a_b|x> <@U123> <#C1|gen> :smile: :+1::skin-tone-2: snake_case 2*3*4 https://y.com/p?q=1&amp;r=2.\n' +
      '&gt; quoted *text* with &lt;tags&gt;\n```pre *block*\nline```\n• item\n';
    const input = chunk.repeat(Math.ceil(200_000 / chunk.length));
    expect(input.length).toBeGreaterThanOrEqual(200_000);
    parseMrkdwn(input); // warm up the JIT like a long-running page would be
    const ms = time(() => parseMrkdwn(input));
    expect(ms).toBeLessThan(100);
  });

  it.each([
    ['stars', '*'.repeat(200_000)],
    ['alternating markers', '*_~'.repeat(70_000)],
    ['open angles', '<'.repeat(200_000)],
    ['angles without close', '<@U1 '.repeat(40_000)],
    ['backticks', '`'.repeat(200_000)],
    ['colons', ':a'.repeat(100_000)],
    ['long shortcode-like run', ':' + 'a'.repeat(200_000)],
    ['fences', '```'.repeat(70_000)],
    ['quote lines', '&gt; x\n'.repeat(30_000)],
    ['url-ish', 'http://'.repeat(30_000)],
    ['closing parens url', 'https://x.com/' + ')'.repeat(200_000)],
    ['one long word', 'a'.repeat(200_000)],
  ])('stays linear on pathological input: %s', (_name, input) => {
    parseMrkdwn(input.slice(0, 1000));
    const ms = time(() => parseMrkdwn(input));
    expect(ms).toBeLessThan(250);
  });
});
