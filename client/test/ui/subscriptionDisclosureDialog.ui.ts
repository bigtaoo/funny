// SubscriptionDisclosureDialog (App Review guideline 3.1.2): the terms shown before an iOS
// auto-renewable subscription purchase. Pins what App Review looks for — length, price, renewal
// terms, and EULA/privacy links that actually open — plus that the card fits every viewport and
// locale, and that only "Subscribe" answers yes.
// Run: npm run test:ui

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
import { SubscriptionDisclosureDialog, APPLE_STANDARD_EULA_URL, wrapMixed } from '../../src/ui/dialogs/SubscriptionDisclosureDialog';
import type { SubscriptionDisclosureInfo } from '../../src/ui/dialogs/subscriptionDisclosure';

// The dialog only ever runs inside the iOS shell; legalUrl() must give the absolute https page there.
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true },
}));

initI18n('en');
afterEach(() => { setLocale('en'); });

const VIEWPORTS: Array<[string, number, number]> = [
  ['phone portrait', 390, 844],
  ['phone landscape', 844, 390],
  ['tablet portrait', 768, 1024],
  ['desktop landscape', 1280, 800],
];
const LOCALES: Locale[] = ['zh', 'en', 'de'];

function build(info: SubscriptionDisclosureInfo, w = 390, h = 844) {
  const answers: boolean[] = [];
  const dlg = new SubscriptionDisclosureDialog(w, h, info, {
    onSubscribe: () => answers.push(true),
    onCancel: () => answers.push(false),
  });
  return { dlg, answers };
}

function texts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  const walk = (c: PIXI.Container): void => {
    for (const ch of c.children) {
      if (ch instanceof PIXI.Text) out.push(ch);
      else if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

/** Tappable children in draw order: the two links (Text), then the two buttons (panels). */
function tappables(root: PIXI.Container): PIXI.Container[] {
  return root.children.filter((c): c is PIXI.Container => c.listenerCount('pointertap') > 0);
}

function tap(node: PIXI.Container): void {
  node.emit('pointertap', {} as PIXI.FederatedPointerEvent);
}

function withWindow(fn: () => void): Array<unknown[]> {
  const calls: Array<unknown[]> = [];
  const g = globalThis as { window?: unknown };
  const had = 'window' in g;
  const prev = g.window;
  g.window = { open: (...args: unknown[]) => { calls.push(args); return null; } };
  try { fn(); } finally { if (had) g.window = prev; else delete g.window; }
  return calls;
}

describe('SubscriptionDisclosureDialog — what App Review needs to see', () => {
  it('monthly card: title, auto-renew kind, 1 month, the given price per month, the renewal terms', () => {
    const { dlg } = build({ product: 'monthly_card', price: '4,99 €' });
    // The dialog pre-wraps its paragraphs, so compare with all whitespace removed.
    const squash = (s: string): string => s.replace(/\s+/g, '');
    const all = squash(texts(dlg.container).map((n) => n.text).join(''));
    expect(all).toContain(squash(t('shop.monthlyCard')));
    expect(all).toContain(squash(t('subDisclosure.kind')));
    expect(all).toContain(squash(t('subDisclosure.length', { period: t('subDisclosure.periodMonth') })));
    expect(all).toContain(squash(t('subDisclosure.priceMonthly', { price: '4,99 €' })));
    expect(all).toContain(squash(t('subDisclosure.terms')));
  });

  it('year card: 1 year and the price per year', () => {
    const { dlg } = build({ product: 'year_card', price: '$49.99' });
    const squash = (s: string): string => s.replace(/\s+/g, '');
    const all = squash(texts(dlg.container).map((n) => n.text).join(''));
    expect(all).toContain(squash(t('shop.yearCard')));
    expect(all).toContain(squash(t('subDisclosure.length', { period: t('subDisclosure.periodYear') })));
    expect(all).toContain(squash(t('subDisclosure.priceYearly', { price: '$49.99' })));
  });

  it('the two links open Apple\'s standard EULA and the absolute https privacy policy', () => {
    const { dlg } = build({ product: 'monthly_card', price: '$4.99' });
    const [eula, privacy] = tappables(dlg.container);
    expect((eula as PIXI.Text).text).toBe('· ' + t('subDisclosure.eula'));
    expect((privacy as PIXI.Text).text).toBe('· ' + t('consent.privacyPolicy'));
    const calls = withWindow(() => { tap(eula!); tap(privacy!); });
    expect(calls).toEqual([
      [APPLE_STANDARD_EULA_URL, '_blank', 'noopener'],
      ['https://nivara.gamestao.com/privacy', '_blank', 'noopener'],
    ]);
  });

  it('only Subscribe answers yes; Cancel answers no; the backdrop answers nothing', () => {
    const { dlg, answers } = build({ product: 'monthly_card', price: '$4.99' });
    const nodes = tappables(dlg.container);
    expect(nodes).toHaveLength(4);
    tap(nodes[2]!);
    tap(nodes[3]!);
    expect(answers).toEqual([true, false]);
  });
});

describe('wrapMixed — mixed CJK/Latin wrapping', () => {
  // Headless measureText is a flat 7px per character, so widths below are in characters × 7.
  const style = new PIXI.TextStyle({ fontSize: 14, fontFamily: 'monospace' });
  const zh = '确认购买后将通过你的 Apple ID 账户扣费。订阅会自动续期，除非在当前周期结束前至少 24 小时取消。';

  it('keeps every line within the width at any width', () => {
    for (let chars = 6; chars <= 30; chars++) {
      for (const line of wrapMixed(zh, style, chars * 7).split('\n')) {
        expect(line.length, `"${line}" at ${chars} chars`).toBeLessThanOrEqual(chars);
      }
    }
  });

  it('never splits "Apple ID" or starts a line with closing punctuation, at any width', () => {
    for (let chars = 9; chars <= 30; chars++) {
      const out = wrapMixed(zh, style, chars * 7);
      expect(out, `at ${chars} chars`).toContain('Apple ID');
      for (const line of out.split('\n')) expect(line[0], `"${line}" at ${chars} chars`).not.toMatch(/[。，；]/);
    }
  });

  it('fills CJK lines instead of stranding a short clause after a Latin word', () => {
    const lines = wrapMixed(zh, style, 20 * 7).split('\n');
    expect(lines[0]!.length).toBeGreaterThanOrEqual(18);
  });

  it('splits a single word only when it alone is wider than the line', () => {
    expect(wrapMixed('in deinen App-Store-Accounteinstellungen.', style, 12 * 7).split('\n'))
      .toEqual(['in deinen', 'App-Store-Ac', 'counteinstel', 'lungen.']);
  });
});

describe('SubscriptionDisclosureDialog — fits every viewport and locale', () => {
  for (const locale of LOCALES) {
    for (const [label, w, h] of VIEWPORTS) {
      it(`[${locale}] ${label} ${w}x${h}: every text stays on screen and nothing overlaps`, () => {
        setLocale(locale);
        const { dlg } = build({ product: 'year_card', price: '49,99 €' }, w, h);
        const nodes = texts(dlg.container)
          .map((n) => ({ text: n.text, b: n.getBounds() }))
          .sort((a, b) => a.b.top - b.b.top);
        expect(nodes.length).toBeGreaterThanOrEqual(8);
        for (const { text, b } of nodes) {
          expect(b.left, `${text} left`).toBeGreaterThanOrEqual(0);
          expect(b.right, `${text} right`).toBeLessThanOrEqual(w);
          expect(b.top, `${text} top`).toBeGreaterThanOrEqual(0);
          expect(b.bottom, `${text} bottom`).toBeLessThanOrEqual(h);
        }
        // No two texts share any area. Short landscape lays out two columns, so side-by-side blocks
        // are fine as long as they do not intersect horizontally.
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]!.b, b = nodes[j]!.b;
            const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            expect(overlapX <= 1 || overlapY <= 1, `"${nodes[i]!.text}" overlaps "${nodes[j]!.text}"`).toBe(true);
          }
        }
        dlg.destroy();
      });
    }
  }
});
