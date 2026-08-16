// The mirror image of i18n-no-dead-keys: that spec catches keys the code stopped using, this one
// catches keys the code uses that the dictionary never got.
//
// System mail is the one place where the *server* picks the i18n key and the client only resolves
// it — `sendSystemMail(..., { subject: 'card.mail.rosterFull.subject', ... })`. Nothing connects the
// two sides: the server compiles, its e2e tests pass (they assert on the key string itself), the
// client compiles, and the mismatch only shows up in the player's inbox. FriendsScene/mail.ts
// mailText() translates the key and falls back to the raw string when t() echoes it back, so a
// missing entry is not a crash — it is a mail whose subject literally reads
// `slg.city.durabilityBreached.subject`.
//
// Which is what this spec found when it was written (16.08.2026): worldsvc has been sending
// slg.city.durabilityBreached.{subject,body} since D-CITY-8 landed, with two call sites in
// combatSiege/helpers.ts and two green e2e tests pinning those exact strings — and no locale ever
// defined them. The mail exists specifically because the design note says losing your capital to a
// durability breach gave the player "no notification at all"; the notification was shipping as a
// raw key.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { zh } from '../src/i18n/locales/zh';
import { en } from '../src/i18n/locales/en';
import { de } from '../src/i18n/locales/de';

const SERVER = path.resolve(__dirname, '../../server');
const SKIP_DIR = /(^|[\\/])(node_modules|dist|coverage|generated|\.git)([\\/]|$)/;

function serverSources(): string[] {
  const out: string[] = [];
  const walk = (p: string): void => {
    if (SKIP_DIR.test(p)) return;
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return; }
    if (/[\\/]src[\\/].*\.ts$/.test(p)) out.push(p);
  };
  walk(SERVER);
  return out;
}

/**
 * i18n keys the server hands to sendSystemMail. Two forms, both real:
 *   subject: 'card.mail.rosterFull.subject'
 *   body: `slg.settle.body|rank=${r}|tier=${tier}`      ← params, split off by mailText()
 * Not every subject/body is a key — anomaly warnings are sent as literal English prose
 * ("Fair Play Warning"). The discriminator is the same one mailText() effectively applies at
 * runtime: dotted, no whitespace. Prose can never match, and a key can never contain a space.
 */
const KEYISH = /^[a-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;

function serverMailKeys(): Map<string, string> {
  const keys = new Map<string, string>(); // key → first file that sends it
  const field = /\b(?:subject|body)\s*:\s*(?:'([^'\n]*)'|`([^`\n]*)`)/g;
  for (const f of serverSources()) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(field)) {
      const raw = m[1] !== undefined ? m[1] : m[2]!;
      const key = raw.split('|')[0]!; // drop `|name=value` interpolation params
      if (!KEYISH.test(key)) continue;
      if (!keys.has(key)) keys.set(key, path.relative(SERVER, f).replace(/\\/g, '/'));
    }
  }
  return keys;
}

describe('server-chosen mail keys exist in the client dictionary', () => {
  const mailKeys = serverMailKeys();

  // Canary (repo convention for source-scanning specs): a scan that quietly matches nothing would
  // make the assertion below vacuous — zero keys all "exist". The probe pins one key that is only
  // reachable through the `key|param=value` branch of the parser, so a regex regression that drops
  // the template-literal form fails here rather than silently narrowing coverage.
  it('the scan actually found the server mail sites', () => {
    expect(mailKeys.size).toBeGreaterThanOrEqual(10);
    expect(mailKeys.has('slg.settle.body')).toBe(true);
  });

  for (const [locale, dict] of Object.entries({ zh, en, de }) as Array<[string, Record<string, string>]>) {
    it(`every key is translated in ${locale}`, () => {
      const missing = [...mailKeys].filter(([k]) => dict[k] === undefined).map(([k, f]) => `${k} (sent by ${f})`);
      expect(missing).toEqual([]);
    });
  }
});
