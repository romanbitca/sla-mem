import { describe, expect, it } from 'vitest';
import {
  askPolitely,
  asksAfterThem,
  casualWords,
  isEnglish,
  isGreetingOnly,
  isPlainRequest,
  isPolite,
  joinMessages,
  missingApostrophes,
  polish,
  prose,
  readable,
  smallIs,
  startsSmall,
  startsWithGreeting,
  withGreeting,
  withoutCasual,
} from './style-text';

describe('prose', () => {
  it('keeps a message’s own words: no code, quotes, links, mentions or emoji', () => {
    expect(
      prose(
        '<@U1> can you check `npm test` :smile:\n&gt; quoted\n```\nlog\n```\nsee <https://x.io|the spec> &amp; more',
      ),
    ).toBe('can you check\nsee & more');
  });
});

describe('isEnglish', () => {
  it('tells English from other languages, and leaves short messages undecided', () => {
    expect(isEnglish('can you check the invoice please')).toBe(true);
    expect(isEnglish('thanks.')).toBe(true);
    expect(isEnglish('putem sa facem un huddle te rog?')).toBe(false);
    expect(isEnglish('Ea e Off azi.')).toBe(false);
    expect(isEnglish('привет, как дела?')).toBe(false);
    expect(isEnglish('Da.')).toBe(false);
  });
});

describe('greetings', () => {
  it('knows an opening hello, in several languages, and “how are you”', () => {
    for (const text of ['Hi Dana, can you check?', 'hello, we need a key', 'Good morning!', 'Salut, ce faci?', 'Hey']) {
      expect(startsWithGreeting(text)).toBe(true);
    }
    expect(startsWithGreeting('Hope you are well. Quick question')).toBe(true);
    expect(startsWithGreeting('can you check this by priority?')).toBe(false);
    expect(startsWithGreeting('Hiring update: two offers out')).toBe(false);
    expect(asksAfterThem('hey, how are you?')).toBe(true);
    expect(asksAfterThem('hey, can you check?')).toBe(false);
  });

  it('knows a hello with nothing to act on', () => {
    for (const text of ['Hello, how are you?', 'hi there', 'Hi, hope you are well.', 'Good morning team!']) {
      expect(isGreetingOnly(text)).toBe(true);
    }
    expect(isGreetingOnly('Hi, can you check the build?')).toBe(false);
    expect(isGreetingOnly('?!')).toBe(false);
  });
});

describe('capitals and apostrophes', () => {
  it('counts “i” for “I”, not “i.e.” or a word part', () => {
    expect(smallIs('i think i can, i.e. soon; wi-fi and iPhone')).toBe(2);
    expect(smallIs('I think')).toBe(0);
  });

  it('finds contractions missing their apostrophe', () => {
    expect(missingApostrophes('im sure we dont need it, thats fine, lets go')).toEqual(['im', 'dont', 'thats']);
  });

  it('knows a message starting with a small letter, but not an address', () => {
    expect(startsSmall('hello there')).toBe(true);
    expect(startsSmall('Hello there')).toBe(false);
    expect(startsSmall('docs.google.com has it')).toBe(false);
    expect(startsSmall('123 tickets')).toBe(false);
  });
});

describe('casual words', () => {
  it('finds slang, laughs, “man” as an address and swearing', () => {
    expect(casualWords('yeah im gonna do it lol, thanks man! hahaha')).toEqual(['yeah', 'gonna', 'lol', 'haha', 'man']);
    expect(casualWords('the man page, the U.S. office, a u-turn')).toEqual([]);
    expect(casualWords('oh shit, damn')).toEqual(['shit', 'damn']);
  });
});

describe('requests', () => {
  it('tells a plain “can you” from a polite one', () => {
    expect(isPlainRequest('can you check this?')).toBe(true);
    expect(isPlainRequest('could you check this?')).toBe(false);
    expect(isPolite('can you check this please?')).toBe(true);
    expect(isPolite('could you check this?')).toBe(true);
    expect(isPolite('can you check this?')).toBe(false);
  });
});

describe('rewrites', () => {
  it('polishes: capitals where sentences start, “I”, and apostrophes', () => {
    expect(polish('i dont have a choice. im working on it.\nthanks')).toBe(
      "I don't have a choice. I'm working on it.\nThanks",
    );
    // Abbreviations, numbered lists, addresses and code keep their case.
    expect(polish('e.g. the first one. 1. we agreed')).toBe('E.g. the first one. 1. We agreed');
    expect(polish('docs.google.com has it')).toBe('docs.google.com has it');
    expect(polish('run `im dont` then check <https://x.io/dont|dont>')).toBe(
      'Run `im dont` then check <https://x.io/dont|dont>',
    );
    // After a mention the sentence reads on; emoji in front are skipped.
    expect(polish('<@U1> can you check?')).toBe('<@U1> can you check?');
    expect(polish(':wave: hi all')).toBe(':wave: Hi all');
  });

  it('swaps casual words for plain ones', () => {
    expect(withoutCasual('yeah, im gonna join. thanks man!')).toBe("Yes, I'm going to join. Thanks!");
    expect(withoutCasual('hahah, pls check it')).toBe('Please check it');
  });

  it('asks politely', () => {
    expect(askPolitely('can you check this by priority?')).toBe('Could you please check this by priority?');
    expect(askPolitely('hey, can you look? thanks')).toBe('Hey, could you look? Thanks');
  });

  it('adds a greeting with their name', () => {
    expect(withGreeting('Can you check the invoice?', 'Dana')).toBe('Hi Dana, can you check the invoice?');
    expect(withGreeting('i need the key', null)).toBe('Hi, I need the key');
  });

  it('joins messages sent in a row into one', () => {
    expect(joinMessages(['im gonna check', 'the logs', 'ok?'])).toBe("I'm gonna check. The logs. Ok?");
  });

  it('reads mrkdwn as Slack shows it', () => {
    const labels = new Map([['U1', 'Ana']]);
    expect(readable('<@U1> see <https://x.io/a|the spec> in <#C1|general> :smile: &amp; <!here>', labels)).toBe(
      '@Ana see the spec in #general & @here',
    );
  });
});
