// EntryGateDialog — the merged age-gate + consent screen (RETENTION_LAUNCH_PLAN.md §3.1). This file
// is the sibling of ageGate.ui.ts/consentDialogWrap.ui.ts for the combined card specifically: it is
// built out of the SAME layout vocabulary (cardHmin/unit fractions) as both of those, but stacks an
// age stepper on top of consent body text + links + up to two buttons, which is exactly the highest
// overflow risk in the whole dialog family — ConsentDialog's own body text alone was already close
// to the card's height budget in short landscape (its 2026-08-11 fix, guarded by
// consentDialogWrap.ui.ts). "Keeps every element on screen" is therefore the load-bearing assertion
// here, across all three locales and both orientations, for the combined ask+choice mode specifically.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, t, setLocale, type Locale } from '../../src/i18n';
import { EntryGateDialog, type EntryGateMode, type EntryGateAnswer } from '../../src/ui/dialogs/EntryGateDialog';

initI18n('en');

const NOW = 2026;
const MIN_AGE = 13;

interface Built { dlg: EntryGateDialog; answers: EntryGateAnswer[] }

function build(mode: EntryGateMode, w = 800, h = 1280): Built {
  const answers: EntryGateAnswer[] = [];
  const dlg = new EntryGateDialog(w, h, mode, { onAnswered: (a) => answers.push(a) }, MIN_AGE, NOW);
  return { dlg, answers };
}

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

function tap(dlg: EntryGateDialog, label: string): void {
  const target = box(dlg.container, label);
  const cx = target.x + target.width / 2;
  const cy = target.y + target.height / 2;
  const btn = buttons(dlg.container).find((bb) => bb.b.contains(cx, cy));
  expect(btn, `"${label}" carries no tap handler (labels: ${texts(dlg.container).map((n) => n.text).join(' | ')})`).toBeDefined();
  btn!.node.emit('pointertap', {} as PIXI.FederatedPointerEvent);
}

function tapStep(dlg: EntryGateDialog, label: '+1' | '−1' | '+10' | '−10', times = 1): void {
  for (let i = 0; i < times; i++) tap(dlg, label);
}

const MODES: Array<[string, EntryGateMode]> = [
  ['ask + choice (the new-player case)', { age: 'ask', consent: 'choice' }],
  ['ask + accept-only', { age: 'ask', consent: 'accept-only' }],
  ['ask only (age-only edge case)', { age: 'ask', consent: null }],
  ['ok + choice (consent-only edge case)', { age: 'ok', consent: 'choice' }],
];

describe('EntryGateDialog — fits every mode, in all three locales, both orientations', () => {
  const VIEWPORTS: Array<[number, number]> = [[800, 1280], [1280, 800], [640, 1136], [1024, 768]];

  for (const locale of ['zh', 'en', 'de'] as Locale[]) {
    for (const [w, h] of VIEWPORTS) {
      for (const [label, mode] of MODES) {
        it(`[${locale}] ${w}x${h}: ${label} keeps every element on screen`, () => {
          setLocale(locale);
          try {
            const { dlg } = build(mode, w, h);
            for (const n of texts(dlg.container)) {
              expect(n.b.x, `"${n.text}" spills left`).toBeGreaterThanOrEqual(0);
              expect(n.b.y, `"${n.text}" spills above`).toBeGreaterThanOrEqual(0);
              expect(n.b.x + n.b.width, `"${n.text}" spills right`).toBeLessThanOrEqual(w);
              expect(n.b.y + n.b.height, `"${n.text}" spills below`).toBeLessThanOrEqual(h);
            }
          } finally {
            setLocale('en');
          }
        });
      }
    }
  }
});

describe('EntryGateDialog — ask + choice (combined tap answers both)', () => {
  it('declares the current stepper year and the pressed consent button in one call', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    tapStep(dlg, '+10'); // 1996 -> 2006
    tap(dlg, t('consent.acceptAll'));
    expect(answers).toEqual([{ birthYear: NOW - 30 + 10, granted: true }]);
  });

  it('the essentials-only button declares age too, with granted: false', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    tap(dlg, t('consent.essentialOnly'));
    expect(answers).toEqual([{ birthYear: NOW - 30, granted: false }]);
  });

  it('an underage stepper value asks for confirmation instead of answering', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    tapStep(dlg, '+10', 2); // 1996 -> 2016
    tapStep(dlg, '−1', 2);  // -> 2014, exactly one year short of the threshold (2013)
    tap(dlg, t('consent.acceptAll'));
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('ageGate.confirmTitle'));
    expect(answers).toEqual([]);

    tap(dlg, t('ageGate.confirmYes'));
    // Confirming an underage year never carries a consent answer — the core blocks before
    // consent would ever be asked (createAppCore.gateConsent).
    expect(answers).toEqual([{ birthYear: NOW - MIN_AGE + 1 }]);
  });
});

describe('EntryGateDialog — reduced modes render the standalone copy unchanged', () => {
  it('age-only (consent already known) shows ageGate.* copy and one Confirm button', () => {
    const { dlg, answers } = build({ age: 'ask', consent: null });
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('ageGate.title'));
    tap(dlg, t('ageGate.confirm'));
    expect(answers).toEqual([{ birthYear: NOW - 30 }]);
  });

  it('consent-only (age already known) shows consent.* copy and no stepper', () => {
    const { dlg, answers } = build({ age: 'ok', consent: 'choice' });
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('consent.title'));
    expect(all.some((s) => /^\d{4}$/.test(s))).toBe(false); // no year stepper drawn
    tap(dlg, t('consent.acceptAll'));
    expect(answers).toEqual([{ granted: true }]);
  });
});
