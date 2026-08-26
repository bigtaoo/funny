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
import { ORG_NAME_WIDTH_MAX } from '@nw/shared';

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

  // drawChatLine truncates a row's body at 60 chars, and the sect name inside these three is
  // player-chosen — so the headroom has to be checked against the widest name the server will
  // accept (ORG_NAME_WIDTH_MAX = 12 display units, i.e. up to 12 ASCII chars), not against a
  // convenient short one. At worst today this lands at 57/60; a future copy edit that adds four
  // words would push the verb off the end of the German line, where nobody would notice it.
  const CHANNEL_KEYS = ['slg.city.captured', 'slg.city.lost', 'slg.city.worldCenterCaptured'] as const;
  // Widest legal name, and a level/coords pair at the top of their ranges, so the margin measured
  // here is the real worst case rather than whatever a sample name happened to be.
  const WIDEST = {
    kind: 'garrison', node: 'n7', level: 9, x: 128, y: 128,
    sect: 'W'.repeat(ORG_NAME_WIDTH_MAX),
  };

  it.each(CHANNEL_KEYS)('%s fits a chat row uncut at the widest legal sect name', (key) => {
    for (const [locale, dict] of LOCALES) {
      const rendered = dict[key]!.replace(/\{(\w+)\}/g, (w, n: string) => String((WIDEST as Record<string, unknown>)[n] ?? w));
      expect(rendered.length, `${key} in ${locale}: "${rendered}"`).toBeLessThanOrEqual(60);
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
