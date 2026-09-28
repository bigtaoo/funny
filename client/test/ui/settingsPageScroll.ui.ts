// SettingsScene page scroll (UI_DESIGN_LOG_2026-09 §65).
//
// The flow layout lets the page grow past the viewport on short portrait phones, so it scrolls. The
// failure modes are all silent in a screenshot:
//  * a drag that starts on a row PRESSES the row instead of scrolling (taps must wait for pointer-up
//    and be dropped once the pointer has travelled);
//  * a row scrolled out of view keeps a live hit rect, so a tap on the header area or on the row
//    now drawn there fires the hidden one;
//  * a page that fits starts deferring taps anyway, changing how every button feels on desktop.
// Driven through the real InputManager, not by poking scene methods.
//
// The headless text stub measures every line far shorter than a browser does, so no REAL viewport
// overflows here (in Chromium 360x640 does). The mechanics are therefore exercised on a design rect
// squashed to 1080x1200 — only designWidth/designHeight are read by the scene, and a short rect
// is exactly the condition that makes a real phone scroll. Whether real devices overflow is the
// browser sweep's job (portrait-report screenshots), not this file's.
import { describe, it, expect } from 'vitest';
import { initI18n, t } from '../../src/i18n';
import type { SettingsScene, SettingsSceneCallbacks } from '../../src/scenes/SettingsScene';
import type { InputManager } from '../../src/inputSystem/InputManager';
import { collectTexts, findText, internals, mountSettings, pageView, reveal, ONLINE, SHORT } from '../harness/settingsScene';

initI18n('en');

function scene(w: number, h: number, extra: Partial<SettingsSceneCallbacks> = {}): { s: SettingsScene; input: InputManager } {
  const short = w === SHORT[0] && h === SHORT[1];
  return mountSettings(w, h, { ...ONLINE, ...extra }, short ? SHORT : undefined);
}

describe('SettingsScene — page scroll', () => {
  it('fits on a desktop window, so it does not scroll and a press still fires on down', () => {
    let replays = 0;
    const { s, input } = scene(1920, 1080, { onReplayTutorial: () => { replays++; } });
    expect(s.pageMaxScroll).toBe(0);
    const n = findText(collectTexts(s.container), t('settings.replayTutorial'));
    input._emitDown((n.left + n.right) / 2, (n.top + n.bottom) / 2);
    expect(replays, 'an unscrollable page must not defer taps to pointer-up').toBe(1);
  });

  it('scrolls when the page is taller than its viewport, and the last row is reachable', () => {
    const { s } = scene(...SHORT);
    expect(s.pageMaxScroll, 'the squashed page is expected to be taller than its viewport').toBeGreaterThan(0);
    reveal(s, t('settings.deleteAccount'));
  });

  it('registers no hit for a row outside the viewport, and every page hit stays inside it', () => {
    const { s } = scene(...SHORT);
    const view = pageView(s);
    const del = findText(collectTexts(s.container), t('settings.deleteAccount'));
    expect(del.top, 'precondition: the delete link starts below the fold').toBeGreaterThan(view.y + view.h);
    const midX = (del.left + del.right) / 2;
    expect(internals(s).hits.some((h) => h.rect.x <= midX && midX <= h.rect.x + h.rect.w && h.rect.y >= view.y + view.h))
      .toBe(false);
    for (const h of internals(s).hits) {
      // The header's back button is the one hit allowed above the page viewport.
      if (h.rect.y + h.rect.h <= view.y) continue;
      expect(h.rect.y).toBeGreaterThanOrEqual(view.y);
      expect(h.rect.y + h.rect.h).toBeLessThanOrEqual(view.y + view.h);
    }
  });

  it('a drag that starts on a row scrolls the page instead of pressing the row', () => {
    let replays = 0;
    const { s, input } = scene(...SHORT, { onReplayTutorial: () => { replays++; } });
    const n = reveal(s, t('settings.replayTutorial'));
    const before = s.pageScrollY;
    const x = (n.left + n.right) / 2, y = (n.top + n.bottom) / 2;
    input._emitDown(x, y);
    input._emitMove(x, y - 40);
    input._emitMove(x, y - 120);
    input._emitUp(x, y - 120);
    s.update(1 / 30); // the drag re-renders at most once per frame
    expect(replays, 'the drag pressed the row it started on').toBe(0);
    expect(s.pageScrollY).not.toBe(before);
  });

  it('a tap on a row of a scrollable page still presses it, on release', () => {
    let replays = 0;
    const { s, input } = scene(...SHORT, { onReplayTutorial: () => { replays++; } });
    const n = reveal(s, t('settings.replayTutorial'));
    const x = (n.left + n.right) / 2, y = (n.top + n.bottom) / 2;
    input._emitDown(x, y);
    expect(replays, 'fired on down — a drag starting here could not be told apart').toBe(0);
    input._emitUp(x, y);
    expect(replays).toBe(1);
  });

  it('the mouse wheel scrolls it, within range', () => {
    const { s, input } = scene(...SHORT);
    const view = pageView(s);
    input._emitWheel(view.w / 2, view.y + view.h / 2, 100000);
    expect(s.pageScrollY).toBe(s.pageMaxScroll);
    input._emitWheel(view.w / 2, view.y + view.h / 2, -100000);
    expect(s.pageScrollY).toBe(0);
  });
});
