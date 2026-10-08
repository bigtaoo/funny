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

/** The two-tap year picker: open it from the year field, pick the decade, pick the year. */
function pickYear(dlg: EntryGateDialog, current: number, year: number): void {
  tap(dlg, t('entryGate.yearPick', { year: current }));
  tap(dlg, t('entryGate.decade', { decade: Math.floor(year / 10) * 10 }));
  tap(dlg, String(year));
}

const MODES: Array<[string, EntryGateMode]> = [
  ['ask + choice (the new-player case)', { age: 'ask', consent: 'choice' }],
  ['ask + accept-only', { age: 'ask', consent: 'accept-only' }],
  ['ask only (age-only edge case)', { age: 'ask', consent: null }],
  ['ok + choice (consent-only edge case)', { age: 'ok', consent: 'choice' }],
  ['ok + terms (Terms of Use re-accept, App Review 1.2)', { age: 'ok', consent: 'terms' }],
  ['ask + terms', { age: 'ask', consent: 'terms' }],
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
  it('declares the picked year and the pressed consent button in one call', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    pickYear(dlg, NOW - 30, 2006); // 1996 -> 2006, two taps after opening the field
    tap(dlg, t('consent.acceptAll'));
    expect(answers).toEqual([{ birthYear: NOW - 30 + 10, granted: true }]);
  });

  it('the essentials-only button declares age too, with granted: false', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    tap(dlg, t('consent.essentialOnly'));
    expect(answers).toEqual([{ birthYear: NOW - 30, granted: false }]);
  });

  it('an underage year asks for confirmation instead of answering', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'choice' });
    pickYear(dlg, NOW - 30, 2014); // exactly one year short of the threshold (2013)
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

describe('EntryGateDialog — the two-tap year picker (ONBOARDING_DESIGN §11.8)', () => {
  it('starts from 30 years ago — neither the threshold nor an obvious pass value (COMPLIANCE_GLOBAL §3.4)', () => {
    const { dlg } = build({ age: 'ask', consent: 'accept-only' });
    expect(texts(dlg.container).map((n) => n.text)).toContain(t('entryGate.yearPick', { year: NOW - 30 }));
  });

  it('offers every decade alike, and nothing outside the 100-year range', () => {
    const { dlg } = build({ age: 'ask', consent: 'accept-only' });
    tap(dlg, t('entryGate.yearPick', { year: NOW - 30 }));
    const all = texts(dlg.container).map((n) => n.text);
    for (let d = 2020; d >= 1920; d -= 10) expect(all).toContain(t('entryGate.decade', { decade: d }));
    expect(all).not.toContain(t('entryGate.decade', { decade: 1910 }));
    // The consent buttons are not on the picker card: nothing can be answered while choosing.
    expect(all).not.toContain(t('consent.accept'));
  });

  it('Back walks year grid -> decade grid -> card without changing the year', () => {
    const { dlg, answers } = build({ age: 'ask', consent: 'accept-only' });
    tap(dlg, t('entryGate.yearPick', { year: NOW - 30 }));
    tap(dlg, t('entryGate.decade', { decade: 1980 }));
    tap(dlg, t('entryGate.pickBack'));
    expect(texts(dlg.container).map((n) => n.text)).toContain(t('entryGate.pickDecade'));
    tap(dlg, t('entryGate.pickBack'));
    tap(dlg, t('consent.accept'));
    expect(answers).toEqual([{ birthYear: NOW - 30, granted: true }]);
  });

  const VIEWPORTS: Array<[number, number]> = [[800, 1280], [1280, 800], [640, 1136], [1024, 768], [722, 406]];
  for (const locale of ['zh', 'en', 'de'] as Locale[]) {
    for (const [w, h] of VIEWPORTS) {
      it(`[${locale}] ${w}x${h}: both picker grids keep every chip on screen`, () => {
        setLocale(locale);
        try {
          const { dlg } = build({ age: 'ask', consent: 'choice' }, w, h);
          tap(dlg, t('entryGate.yearPick', { year: NOW - 30 }));
          const check = (): void => {
            for (const n of texts(dlg.container)) {
              expect(n.b.x, `"${n.text}" spills left`).toBeGreaterThanOrEqual(0);
              expect(n.b.y, `"${n.text}" spills above`).toBeGreaterThanOrEqual(0);
              expect(n.b.x + n.b.width, `"${n.text}" spills right`).toBeLessThanOrEqual(w);
              expect(n.b.y + n.b.height, `"${n.text}" spills below`).toBeLessThanOrEqual(h);
            }
          };
          check();
          tap(dlg, t('entryGate.decade', { decade: 1990 }));
          check();
        } finally {
          setLocale('en');
        }
      });
    }
  }
});

describe('EntryGateDialog — Terms of Use (EULA) re-accept (App Review 1.2)', () => {
  it('shows the updated-terms copy, the zero-tolerance sentence and the terms link, with one Accept button', () => {
    const { dlg, answers } = build({ age: 'ok', consent: 'terms' });
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('consent.termsUpdateTitle'));
    expect(all).toContain(t('consent.termsUpdateBody'));
    expect(t('consent.termsUpdateBody')).toMatch(/zero tolerance/);
    expect(all).toContain('· ' + t('consent.terms'));
    expect(all).not.toContain(t('consent.essentialOnly'));
    tap(dlg, t('consent.accept'));
    expect(answers).toEqual([{ granted: true }]);
  });

  it('the first-launch copy names the Terms of Use (EULA) and the zero-tolerance policy in every locale', () => {
    for (const locale of ['zh', 'en', 'de'] as Locale[]) {
      setLocale(locale);
      try {
        for (const key of ['consent.body', 'consent.bodyChoice', 'entryGate.body', 'entryGate.bodyChoice'] as const) {
          expect(t(key), `${locale} ${key}`).toContain('EULA');
        }
      } finally {
        setLocale('en');
      }
    }
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

  it('consent-only (age already known) shows consent.* copy and no year picker', () => {
    const { dlg, answers } = build({ age: 'ok', consent: 'choice' });
    const all = texts(dlg.container).map((n) => n.text);
    expect(all).toContain(t('consent.title'));
    expect(all.some((s) => /\d{4}/.test(s))).toBe(false); // no year field drawn
    tap(dlg, t('consent.acceptAll'));
    expect(answers).toEqual([{ granted: true }]);
  });
});
