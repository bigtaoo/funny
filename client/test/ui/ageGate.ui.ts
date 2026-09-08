// AgeGateDialog — the screen behind the App Store questionnaire's "Age Assurance" row
// (store-assets-checklist §1.5, `privacy-policy §9`). The wiring around it is asserted in
// test/ageGate.test.ts; this file is about the card itself, where three things can go wrong in ways
// no screenshot of one viewport would show:
//
//  * it must FIT — the card is laid out top-down from hand-tuned fractions of its own height (the
//    ConsentDialog vocabulary), so a row that does not fit just draws over its neighbour;
//  * the stepper must CLAMP — a year past the current one is not a birth year, and a stepper at the
//    end of its range stays on screen (dimmed), so "disabled" has to mean "tapping moves nothing";
//  * a below-threshold answer must be CONFIRMED first — the recorded answer is permanent, so the
//    single tap that would matter is the one the second card catches.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t, setLocale, type Locale } from '../../src/i18n';
import { AgeGateDialog, type AgeGateMode } from '../../src/ui/dialogs/AgeGateDialog';

initI18n('en');

/** A fixed "now" so the expected years are literals rather than a re-derivation of the same math. */
const NOW = 2026;
const MIN_AGE = 13;

interface Built { dlg: AgeGateDialog; declared: number[] }

function build(mode: AgeGateMode = 'ask', w = 800, h = 1280): Built {
  const declared: number[] = [];
  const dlg = new AgeGateDialog(w, h, mode, { onDeclared: (y) => declared.push(y) }, MIN_AGE, NOW);
  return { dlg, declared };
}

/** Every Text node in the tree, with its on-screen box. */
function texts(root: PIXI.Container): Array<{ text: string; b: PIXI.Rectangle }> {
  const out: Array<{ text: string; b: PIXI.Rectangle }> = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch instanceof PIXI.Text) { out.push({ text: ch.text, b: ch.getBounds() }); continue; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

function box(root: PIXI.Container, text: string): PIXI.Rectangle {
  const hit = texts(root).find((n) => n.text === text);
  if (!hit) throw new Error(`no text node "${text}" (have: ${texts(root).map((n) => n.text).join(' | ')})`);
  return hit.b;
}

/**
 * Every tappable node in the tree — PIXI does the hit-testing here, so a "button" is a listener
 * plus a box. Walks the tree because each button is a group (panel + label) with the handler on
 * the panel inside it.
 */
function buttons(root: PIXI.Container): Array<{ node: PIXI.Container; b: PIXI.Rectangle }> {
  const out: Array<{ node: PIXI.Container; b: PIXI.Rectangle }> = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (!(ch instanceof PIXI.Container)) continue;
      if (ch.listenerCount('pointertap') > 0) out.push({ node: ch, b: ch.getBounds() });
      walk(ch);
    }
  };
  walk(root);
  return out;
}

/** Tap the button whose box contains the centre of `label`'s text — the way a finger finds it. */
function tap(dlg: AgeGateDialog, label: string): void {
  const target = box(dlg.container, label);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const btn = buttons(dlg.container).find((bb) => bb.b.contains(cx, cy));
  expect(btn, `"${label}" carries no tap handler (labels: ${texts(dlg.container).map((n) => n.text).join(' | ')})`).toBeDefined();
  // The handler ignores its argument (tapHandler wraps a zero-arg closure); PIXI's typings insist.
  btn!.node.emit('pointertap', {} as PIXI.FederatedPointerEvent);
}

/** A stepper's own opacity — full when it can still move the year, dimmed at the end of the range. */
function alphaOf(dlg: AgeGateDialog, label: string): number {
  const target = box(dlg.container, label);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const group = dlg.container.children.find(
    (ch): ch is PIXI.Container => ch instanceof PIXI.Container && ch.getBounds().contains(cx, cy) && ch.children.length > 1,
  );
  expect(group, `no button group around "${label}"`).toBeDefined();
  return group!.alpha;
}

const year = (dlg: AgeGateDialog): number => {
  const nums = texts(dlg.container).map((n) => n.text).filter((s) => /^\d{4}$/.test(s));
  expect(nums, 'exactly one four-digit year should be on screen').toHaveLength(1);
  return Number(nums[0]);
};

describe('AgeGateDialog — ask', () => {
  it('opens 30 years back, which is neither the threshold nor an obvious pass', () => {
    expect(year(build().dlg)).toBe(NOW - 30);
  });

  it.each<Locale>(['zh', 'en', 'de'])('draws title, body and confirm in %s', (locale) => {
    setLocale(locale);
    const all = texts(build().dlg.container).map((n) => n.text);
    expect(all).toContain(t('ageGate.title'));
    expect(all).toContain(t('ageGate.confirm'));
    expect(all.some((s) => s.includes(t('ageGate.body').slice(0, 12)))).toBe(true);
    setLocale('en');
  });

  it.each([[800, 1280], [1280, 800], [640, 1136], [1024, 768]])('keeps every element on screen at %ix%i', (w, h) => {
    const { dlg } = build('ask', w, h);
    for (const n of texts(dlg.container)) {
      expect(n.b.x, `"${n.text}" spills left`).toBeGreaterThanOrEqual(0);
      expect(n.b.y, `"${n.text}" spills above`).toBeGreaterThanOrEqual(0);
      expect(n.b.x + n.b.width, `"${n.text}" spills right`).toBeLessThanOrEqual(w);
      expect(n.b.y + n.b.height, `"${n.text}" spills below`).toBeLessThanOrEqual(h);
    }
  });

  it('puts the year between the two decrement and the two increment buttons', () => {
    const { dlg } = build();
    const y = box(dlg.container, String(NOW - 30));
    expect(box(dlg.container, '−10').x).toBeLessThan(box(dlg.container, '−1').x);
    expect(box(dlg.container, '−1').x + box(dlg.container, '−1').width).toBeLessThanOrEqual(y.x);
    expect(box(dlg.container, '+1').x).toBeGreaterThanOrEqual(y.x + y.width);
    expect(box(dlg.container, '+1').x).toBeLessThan(box(dlg.container, '+10').x);
  });

  it('does not let the stepper row and the confirm button overlap', () => {
    const { dlg } = build();
    const row = box(dlg.container, '−10');
    const confirm = box(dlg.container, t('ageGate.confirm'));
    expect(confirm.y).toBeGreaterThanOrEqual(row.y + row.height);
  });

  it('steps by ±1 and ±10', () => {
    const { dlg } = build();
    tap(dlg, '+1');
    expect(year(dlg)).toBe(NOW - 29);
    tap(dlg, '+10');
    expect(year(dlg)).toBe(NOW - 19);
    tap(dlg, '−1');
    expect(year(dlg)).toBe(NOW - 20);
    tap(dlg, '−10');
    expect(year(dlg)).toBe(NOW - 30);
  });

  it('clamps at the current year, dimming the increments instead of dropping them', () => {
    const { dlg } = build();
    tap(dlg, '+10'); tap(dlg, '+10'); tap(dlg, '+10'); // 1996 → 2026
    expect(year(dlg)).toBe(NOW);
    expect(alphaOf(dlg, '+1')).toBeLessThan(1);
    expect(alphaOf(dlg, '+10')).toBeLessThan(1);
    expect(alphaOf(dlg, '−1')).toBe(1);
    tap(dlg, '+1'); // still tappable, and still refuses to leave the range
    expect(year(dlg)).toBe(NOW);
  });

  it('keeps the same stepper objects across taps, so a quick second tap is not lost', () => {
    // The bug this pins: rebuilding the card per tap destroys the node the gesture is on, and in a
    // real browser the second of two quick taps vanished. Identity is the observable.
    const { dlg } = build();
    const before = buttons(dlg.container).map((b) => b.node);
    tap(dlg, '+1');
    tap(dlg, '+1');
    expect(year(dlg)).toBe(NOW - 28);
    expect(buttons(dlg.container).map((b) => b.node)).toEqual(before);
  });

  it('reports an at-threshold year straight away, with no extra confirmation', () => {
    const { dlg, declared } = build();
    tap(dlg, '+10'); // 1996 → 2006
    for (let i = 0; i < 7; i++) tap(dlg, '+1'); // → 2013, the oldest year that is exactly MIN_AGE
    expect(year(dlg)).toBe(NOW - MIN_AGE); // 2013
    tap(dlg, t('ageGate.confirm'));
    expect(declared).toEqual([NOW - MIN_AGE]);
  });
});

describe('AgeGateDialog — below the threshold', () => {
  /** Steps up to a year that is one short of the threshold (2014 for NOW=2026, MIN_AGE=13). */
  function tooYoung(): Built {
    const b = build();
    tap(b.dlg, '+10'); tap(b.dlg, '+10'); // 1996 → 2016
    tap(b.dlg, '−1'); tap(b.dlg, '−1');   // → 2014
    expect(year(b.dlg)).toBe(NOW - MIN_AGE + 1);
    return b;
  }

  it('asks for confirmation instead of reporting the year', () => {
    const { dlg, declared } = tooYoung();
    tap(dlg, t('ageGate.confirm'));
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('ageGate.confirmTitle'));
    expect(all.some((s) => s.includes(String(NOW - MIN_AGE + 1)))).toBe(true); // the year is quoted back
    expect(declared).toEqual([]);
  });

  it('reports the year only after the second confirmation', () => {
    const { dlg, declared } = tooYoung();
    tap(dlg, t('ageGate.confirm'));
    tap(dlg, t('ageGate.confirmYes'));
    expect(declared).toEqual([NOW - MIN_AGE + 1]);
  });

  it('goes back to the stepper — with the year intact — when the player declines', () => {
    const { dlg, declared } = tooYoung();
    tap(dlg, t('ageGate.confirm'));
    tap(dlg, t('ageGate.confirmBack'));
    expect(year(dlg)).toBe(NOW - MIN_AGE + 1);
    expect(texts(dlg.container).map((n) => n.text)).toContain(t('ageGate.title'));
    expect(declared).toEqual([]);
  });
});

describe('AgeGateDialog — blocked', () => {
  it('is a dead end: it draws no tappable control at all', () => {
    const { dlg } = build('blocked');
    expect(buttons(dlg.container)).toHaveLength(0);
  });

  it('names the threshold and a way to reach a human', () => {
    const { dlg } = build('blocked');
    const body = texts(dlg.container).map((n) => n.text).join(' ');
    expect(body).toContain(String(MIN_AGE));
    expect(body).toContain('support@gamestao.com');
  });

  it.each([[800, 1280], [1280, 800]])('keeps the blocked card on screen at %ix%i', (w, h) => {
    const { dlg } = build('blocked', w, h);
    for (const n of texts(dlg.container)) {
      expect(n.b.y, `"${n.text}" spills above`).toBeGreaterThanOrEqual(0);
      expect(n.b.y + n.b.height, `"${n.text}" spills below`).toBeLessThanOrEqual(h);
      expect(n.b.x + n.b.width, `"${n.text}" spills right`).toBeLessThanOrEqual(w);
    }
  });
});
