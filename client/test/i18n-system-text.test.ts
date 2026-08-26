// systemText: resolving a server-authored string that is really an i18n key
// (client/src/i18n/systemText.ts).
//
// Two surfaces share this: system mail (FriendsScene/mail.ts) and system *announcements* on the
// sect/world chat channels (ui/widgets/chatRow.ts). Both carry player-authored prose in the very
// same field, so the no-op-for-non-keys behaviour below is what makes it safe to apply to a whole
// channel rather than only to rows whose sender happens to be 'system'.
//
// The param contract is the sharp edge, and it drew blood once already: params are strictly
// `name=value`, so a *positional* segment is parsed as a param with no name and silently dropped.
// worldsvc's ADR-074 capture announcement shipped as `key|garrison|node7|3|12|34|sect=X`, which made
// the city's level and coordinates vanish on the way to the copy — a capture notice that could not
// say which city had been captured. Hence `named params survive / positional ones do not`.
import { describe, it, expect } from 'vitest';
import { systemText } from '../src/i18n/systemText';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';
import { ORG_NAME_WIDTH_MAX, orgNameWidth } from '@nw/shared';

describe('systemText', () => {
  it('translates a bare key', () => {
    expect(systemText('slg.city.captured.subject')).toBe(zh['slg.city.captured.subject']);
  });

  it('interpolates named params', () => {
    const out = systemText('slg.city.worldCenterCaptured|kind=worldCenter|node=n7|level=9|x=12|y=34|sect=IronSect');
    expect(out).toContain('IronSect');
    expect(out).toContain('12');
    expect(out).toContain('34');
    expect(out).not.toContain('{'); // every placeholder in the string got a value
    expect(out).not.toContain('|');
  });

  it('leaves player-authored prose untouched (not a key)', () => {
    expect(systemText('hey, anyone up for a siege?')).toBe('hey, anyone up for a siege?');
  });

  it('falls back to the raw string when the key is not in the dictionary', () => {
    // The failure mode this guards is a mail/announcement whose body literally reads
    // `slg.city.somethingNew.body` in the player's inbox.
    expect(systemText('slg.city.notAKeyAnyone.added')).toBe('slg.city.notAKeyAnyone.added');
    expect(systemText('slg.city.notAKeyAnyone.added|x=1')).toBe('slg.city.notAKeyAnyone.added|x=1');
  });

  it('prose containing a pipe survives intact', () => {
    // Split on '|' happens before the lookup, so the fallback has to restore the whole raw string.
    expect(systemText('good game | well played')).toBe('good game | well played');
  });

  it('drops positional params but keeps named ones — why the server must name every param', () => {
    // The old worldsvc format. `{level}`/`{x}`/`{y}` have no value to bind, so t() leaves the
    // placeholders in place; `sect=` was the one segment that was already named, so it is the only
    // one that resolves — which is exactly how the bug hid, half the sentence looked fine.
    const positional = systemText('slg.city.lost|garrison|n7|3|12|34|sect=IronSect');
    expect(positional).toContain('IronSect');
    expect(positional).toContain('{level}');
    expect(positional).toContain('{x}');
    // The named format the server now sends fills them all in.
    const named = systemText('slg.city.lost|kind=garrison|node=n7|level=3|x=12|y=34|sect=IronSect');
    expect(named).not.toContain('{');
    expect(named).toContain('3');
    expect(named).toContain('12');
  });

  it('a param value containing "=" keeps everything after the first "="', () => {
    const out = systemText('slg.city.worldCenterCaptured|level=1|x=0|y=0|sect=a=b');
    expect(out).toContain('a=b');
  });
});

// The five ADR-074 capture keys must interpolate cleanly in every locale — a placeholder the server
// never sends would sit in the player's inbox as a literal `{level}`.
describe('ADR-074 capture copy binds every placeholder it declares', () => {
  const SENT = ['kind', 'node', 'level', 'x', 'y', 'sect']; // what cityDamage.ts's body() sends
  const KEYS = [
    'slg.city.captured.mail',
    'slg.city.captured',
    'slg.city.lost',
    'slg.city.worldCenterCaptured',
  ] as const;

  const LOCALES: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['de', de]];

  // drawChatLine draws one unwrapped line, so an announcement that overruns its channel loses its
  // tail. Since 2026-08-26 it truncates by available WIDTH with an `…` (ui/widgets/truncateText.ts)
  // rather than at 60 characters, so an overrun now degrades legibly instead of vanishing mid-word —
  // but a capture notice that cannot say which city was taken is still a broken notice, hence a
  // budget here.
  //
  // The budget is in DISPLAY UNITS (orgNameWidth: full-width/CJK = 2, everything else = 1), not
  // characters. That is the whole point: a character count is what made the previous version of this
  // test wrong twice over. It carried a 34-CJK / 41-Latin pair, and those two cannot both describe
  // one column — a monospace CJK glyph is ~1.8 Latin advances, so 34 CJK is ~62 units against 41.
  // One number in the right unit replaces both.
  //
  // Where the numbers come from — measured in a real browser (Playwright against `npm run
  // start:e2e`, window.__nwE2E, viewport 1600x900 → the NARROWEST landscape design width, 1920;
  // the harness in test:ui cannot answer this, its measureText is a flat 7px/code-unit). At
  // FS.label = 24 the real monospace advance is 13.2px Latin / 24.0px CJK (ratio 1.82), and the
  // body's available width for a `system`-tagged row came out at:
  //   sect channel (SectScene/lists.ts, landscape split column)   700px = 53.0 units
  //   world channel (FriendsScene/worldChat.ts, full-width row)  1386px = 105.0 units
  // Both include drawChatLine's ": " prefix (2 units), which the dictionary string does not, and
  // both are stable across locales because the cap is geometry. Budgets below take the remainder
  // minus a small margin. orgNameWidth charging CJK 2.0 against a real 1.82 is itself conservative.
  const SECT_CHANNEL = ['slg.city.captured', 'slg.city.lost'] as const;      // postSect → narrow column
  const WORLD_CHANNEL = ['slg.city.worldCenterCaptured'] as const;           // nationMessages → full width
  const SECT_BUDGET = 48;    // of 51 available
  const WORLD_BUDGET = 96;   // of 103 available
  const WIDEST = {
    kind: 'garrison', node: 'n7', level: 9, x: 128, y: 128,
    // The sect name is player-chosen, so measure at the widest the server will accept, not a
    // convenient short sample.
    sect: 'W'.repeat(ORG_NAME_WIDTH_MAX),
  };
  const render = (s: string) => s.replace(/\{(\w+)\}/g, (w, n: string) => String((WIDEST as Record<string, unknown>)[n] ?? w));

  it.each(SECT_CHANNEL)('%s fits the sect channel column at the widest legal sect name', (key) => {
    for (const [locale, dict] of LOCALES) {
      const out = render(dict[key]!);
      const width = orgNameWidth(out);
      expect(width, `${key} in ${locale} is ${width}/${SECT_BUDGET} display units: "${out}"`)
        .toBeLessThanOrEqual(SECT_BUDGET);
    }
  });

  it.each(WORLD_CHANNEL)('%s fits a full-width chat row at the widest legal sect name', (key) => {
    for (const [locale, dict] of LOCALES) {
      const out = render(dict[key]!);
      const width = orgNameWidth(out);
      expect(width, `${key} in ${locale} is ${width}/${WORLD_BUDGET} display units: "${out}"`)
        .toBeLessThanOrEqual(WORLD_BUDGET);
    }
  });

  it.each(KEYS)('%s declares no placeholder the server does not send', (key) => {
    for (const [locale, dict] of LOCALES) {
      const declared = [...(dict[key] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
      // a capture notice with no params cannot say which city it is about
      expect(declared.length, `${key} in ${locale}`).toBeGreaterThan(0);
      expect(declared.filter((p) => !SENT.includes(p)), `${key} in ${locale}`).toEqual([]);
    }
  });
});
