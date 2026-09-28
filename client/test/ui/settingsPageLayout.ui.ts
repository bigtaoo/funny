// SettingsScene page structure (UI_DESIGN_LOG_2026-09 §65) — the decisions the flow layout made that
// a screenshot shows once and nothing else guards afterwards:
//  * where each section goes (landscape: left = profile / volume / account, right = general / help;
//    portrait: one column, in that reading order);
//  * the landscape left column's height budget — it is full, and one more row there makes every
//    desktop window scroll, silently;
//  * the account card online vs offline, and the demoted delete link still opening its confirm;
//  * an open overlay freezes the page under it; a stale scroll offset is pulled back into range;
//  * the sound toggle follows the page-wide "on = blue" convention (it used to be a red "Muted");
//  * the avatar is the picker's entry point.
// Driven through the real InputManager wherever a tap is involved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initI18n, setLocale, t } from '../../src/i18n';
import { ui as C } from '../../src/render/sketchUi';
import { getAudioSettings, resetAudioSettingsForTest, setAudioMuted } from '../../src/audio/audioSettings';
import { pageMetrics } from '../../src/scenes/SettingsScene/layout';
import type { SettingsScene } from '../../src/scenes/SettingsScene';
import type { InputManager } from '../../src/inputSystem/InputManager';
import type { Rect } from '../../src/layout/ILayout';
import {
  buildSettings, collectTexts, controlHit, findText, internals, mountSettings, pageView, reveal, tap,
  ONLINE, SHORT, type TextNode,
} from '../harness/settingsScene';

initI18n('en');

/** Landscape shapes: design height is always 1080, so only the column width changes. */
const LANDSCAPE: ReadonlyArray<readonly [number, number]> = [[1920, 1080], [1280, 720], [844, 390], [2340, 1080], [1920, 900]];
const PORTRAIT: ReadonlyArray<readonly [number, number]> = [[390, 844], [360, 640], [1080, 1920]];
const LOCALES = ['en', 'zh', 'de'] as const;

function state(s: SettingsScene): { deleteConfirmOpen: boolean; avatarPickerOpen: boolean } {
  return s as unknown as { deleteConfirmOpen: boolean; avatarPickerOpen: boolean };
}

function tapRect(input: InputManager, r: Rect): void {
  const x = r.x + r.w / 2, y = r.y + r.h / 2;
  input._emitDown(x, y);
  input._emitUp(x, y);
}

/** Section headings, plus the player name standing in for the untitled profile card. */
function anchors(s: SettingsScene): Record<'profile' | 'audio' | 'general' | 'help' | 'account', TextNode> {
  const texts = collectTexts(s.container);
  return {
    profile: findText(texts, 'Tester'),
    audio: findText(texts, t('settings.audio')),
    general: findText(texts, t('settings.general')),
    help: findText(texts, t('settings.help')),
    account: findText(texts, t('settings.account')),
  };
}

describe('SettingsScene — which section goes where', () => {
  afterEach(() => setLocale('en'));

  for (const loc of LOCALES) {
    for (const [w, h] of LANDSCAPE) {
      it(`${loc} ${w}x${h} landscape: profile, volume, account on the left; general, help on the right`, () => {
        setLocale(loc);
        const s = buildSettings(w, h);
        const mid = pageView(s).w / 2;
        const a = anchors(s);
        for (const k of ['profile', 'audio', 'account'] as const) expect(a[k].right, `${k} left of centre`).toBeLessThan(mid);
        for (const k of ['general', 'help'] as const) expect(a[k].left, `${k} right of centre`).toBeGreaterThan(mid);
        expect(a.profile.top).toBeLessThan(a.audio.top);
        expect(a.audio.top).toBeLessThan(a.account.top);
        expect(a.general.top).toBeLessThan(a.help.top);
        // Both columns start at the same line: the right column must not be pushed down by the left.
        expect(a.general.top).toBeLessThan(a.audio.top);
      });
    }
    for (const [w, h] of PORTRAIT) {
      it(`${loc} ${w}x${h} portrait: one column, profile → volume → general → help → account`, () => {
        setLocale(loc);
        const s = buildSettings(w, h);
        const a = anchors(s);
        const order = [a.profile, a.audio, a.general, a.help, a.account];
        for (let i = 1; i < order.length; i++) expect(order[i]!.top).toBeGreaterThan(order[i - 1]!.bottom);
        // Headings share one left edge (the profile's name sits beside the avatar, so it is not one).
        const x = a.audio.left;
        for (const n of [a.general, a.help, a.account]) expect(Math.abs(n.left - x)).toBeLessThanOrEqual(1);
      });
    }
  }
});

describe('SettingsScene — landscape left column height budget', () => {
  afterEach(() => setLocale('en'));

  // The left column is full at 1080 design px. The headless text stub measures lines shorter than a
  // browser, so "does not scroll here" alone would still pass after a row is added and a real
  // desktop window started scrolling. Demanding a whole row of slack is what makes this bite: one
  // more row in the left column fails it. New settings belong in the right column (§65).
  for (const loc of LOCALES) {
    for (const [w, h] of LANDSCAPE) {
      it(`${loc} ${w}x${h}: fits with at least one row of room below the delete link`, () => {
        setLocale(loc);
        const s = buildSettings(w, h);
        expect(s.pageMaxScroll).toBe(0);
        const view = pageView(s);
        const del = findText(collectTexts(s.container), t('settings.deleteAccount'));
        const { rowMinH } = pageMetrics(view.w, view.y + view.h);
        expect(view.y + view.h - del.bottom, 'left column is over its budget — put the new row in the right column')
          .toBeGreaterThanOrEqual(rowMinH);
      });
    }
  }
});

describe('SettingsScene — account card', () => {
  it('online: a Log out row that logs out, no Log in, and the red delete link opens the confirm', () => {
    let logouts = 0;
    const { s, input } = mountSettings(1920, 1080, { ...ONLINE, onLogout: () => { logouts++; } });
    const texts = collectTexts(s.container);
    expect(texts.some((n) => n.text === t('auth.loginEntry'))).toBe(false);
    tap(input, findText(texts, t('auth.logout')));
    expect(logouts).toBe(1);

    const del = findText(collectTexts(s.container), t('settings.deleteAccount'));
    expect(del.fill, 'delete is demoted to red text, not a button').toBe(C.red);
    expect(state(s).deleteConfirmOpen).toBe(false);
    tap(input, del);
    expect(state(s).deleteConfirmOpen).toBe(true);
  });

  it('offline: the explanation and a Log in button that logs in — no Log out, no delete', () => {
    let logins = 0;
    // onLogout / onDeleteAccount stay present: offline mode alone must hide them.
    const { s, input } = mountSettings(1920, 1080, { ...ONLINE, offline: true, onLogin: () => { logins++; } });
    const texts = collectTexts(s.container);
    findText(texts, t('settings.offlineHint'));
    expect(texts.some((n) => n.text === t('auth.logout'))).toBe(false);
    expect(texts.some((n) => n.text === t('settings.deleteAccount'))).toBe(false);
    tap(input, findText(texts, t('auth.loginEntry')));
    expect(logins).toBe(1);
  });
});

describe('SettingsScene — page scroll state', () => {
  it('an open overlay freezes the page: neither the wheel nor a drag scrolls it', () => {
    const { s, input } = mountSettings(...SHORT, ONLINE, SHORT);
    expect(s.pageMaxScroll).toBeGreaterThan(0);
    s.openDelete();
    const view = pageView(s);
    input._emitWheel(view.w / 2, view.y + view.h / 2, 100000);
    expect(s.pageScrollY).toBe(0);
    // The far left edge: dim backdrop, not one of the dialog's buttons.
    const x = 4, y = view.y + view.h - 40;
    input._emitDown(x, y);
    input._emitMove(x, y - 300);
    input._emitUp(x, y - 300);
    s.update(1 / 30);
    expect(s.pageScrollY).toBe(0);
  });

  it('an offset left over from a taller layout is pulled back into range, with hits to match', () => {
    const { s } = mountSettings(...SHORT, ONLINE, SHORT);
    s.pageScrollY = s.pageMaxScroll + 500;
    s.render();
    expect(s.pageScrollY).toBe(s.pageMaxScroll);
    const view = pageView(s);
    for (const h of internals(s).hits) {
      if (h.rect.y + h.rect.h <= view.y) continue; // the header's back button
      expect(h.rect.y + h.rect.h).toBeLessThanOrEqual(view.y + view.h);
    }
    // Clamped to the bottom, the last row is on screen without scrolling any further.
    const del = findText(collectTexts(s.container), t('settings.deleteAccount'));
    expect(del.bottom).toBeLessThanOrEqual(view.y + view.h);
  });
});

describe('SettingsScene — sound toggle', () => {
  beforeEach(() => resetAudioSettingsForTest());
  afterEach(() => resetAudioSettingsForTest());

  it('reads "On" in the blue on-state when unmuted, and a tap mutes', () => {
    setAudioMuted(false);
    const { s, input } = mountSettings(1920, 1080);
    const on = findText(collectTexts(s.container), t('settings.audioMuteOff'));
    expect(on.fill, 'on = white label on the blue box, like every other toggle').toBe(0xffffff);
    tapRect(input, controlHit(s, t('settings.audioEnabled')).rect);
    expect(getAudioSettings().muted).toBe(true);
    const texts = collectTexts(s.container);
    expect(texts.some((n) => n.text === t('settings.audioMuteOff'))).toBe(false);
    const muted = findText(texts, t('settings.audioMuteOn'));
    expect(muted.fill, 'muted is the plain off-state, not an alarm').toBe(C.dark);
  });

  it('a tap on the muted toggle unmutes', () => {
    setAudioMuted(true);
    const { s, input } = mountSettings(1920, 1080);
    tapRect(input, controlHit(s, t('settings.audioEnabled')).rect);
    expect(getAudioSettings().muted).toBe(false);
    findText(collectTexts(s.container), t('settings.audioMuteOff'));
  });
});

describe('SettingsScene — avatar', () => {
  /** A hit left of the player name, on its line: the avatar. */
  function avatarHit(s: SettingsScene): Rect | undefined {
    const name = reveal(s, 'Tester');
    const cy = (name.top + name.bottom) / 2;
    return internals(s).hits.map((h) => h.rect).find((r) => r.x + r.w <= name.left && r.y <= cy && cy <= r.y + r.h);
  }

  it('with avatar picking enabled, tapping the avatar opens the picker', () => {
    const { s, input } = mountSettings(1920, 1080, { ...ONLINE, onSetAvatar() {} });
    const r = avatarHit(s);
    expect(r, 'no tap target on the avatar').toBeDefined();
    tapRect(input, r!);
    expect(state(s).avatarPickerOpen).toBe(true);
  });

  it('without it, the avatar is not a tap target', () => {
    const s = buildSettings(1920, 1080);
    expect(avatarHit(s)).toBeUndefined();
  });
});
