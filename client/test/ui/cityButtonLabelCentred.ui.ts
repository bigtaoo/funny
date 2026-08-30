// CityScene button labels are CENTRED in their button (UI_DESIGN_LOG_2026-08.md §42.4).
//
// Every button label in the game is anchor(0.5, 0.5) — ui/dialogs/confirmDialog, ShopScene/card's
// drawButton, ui/widgets/HubTabs. CityScene was the holdout: `addBtn` pinned its label to `x + 12`
// and centred it vertically against a HARDCODED 22px line height rather than the label's measured
// one, so a short label sat against the left edge of a wide button, and CJK vs Latin (which have
// different real line heights at the same fontSize) sat at different vertical offsets in the same
// button. Neither is visible to a behaviour assertion — the hit rect and the callback are identical
// either way — which is why it survived from the scene's first draft.
//
// `addBtn` is the single funnel for CityScene's page-level buttons (Fill All Teams, the build-queue
// bar's Speed Up), so testing the helper covers every current and future caller by construction.
// The two modals draw their buttons inline instead of through it; those are pinned where they are
// exercised — see the centring cases in cityModalSpeedup.ui.ts and cityTrainTroops.ui.ts.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts setupFiles). Run: npm run test:ui
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { addBtn, type ArtHost } from '../../src/scenes/CityScene/helpers';
import { ui as C } from '../../src/render/sketchUi';

type Hit = { x: number; y: number; w: number; h: number; fn: () => void };

function host(): ArtHost & { hits: Hit[] } {
  return {
    container: new PIXI.Container(),
    destroyed: false,
    artHooked: new Set<string>(),
    hits: [] as Hit[],
    render: () => {},
  };
}

/** The single PIXI.Text the helper drew. */
function labelOf(h: ArtHost): PIXI.Text {
  const texts = (h.container.children as PIXI.DisplayObject[]).filter(
    (c): c is PIXI.Text => c instanceof PIXI.Text,
  );
  expect(texts).toHaveLength(1);
  return texts[0]!;
}

/** Signed offset of the label's drawn centre from the button rect's centre, in design px. */
function offsetFromCentre(
  lbl: PIXI.Text,
  r: { x: number; y: number; w: number; h: number },
): { dx: number; dy: number } {
  const b = lbl.getBounds();
  return {
    dx: b.x + b.width / 2 - (r.x + r.w / 2),
    dy: b.y + b.height / 2 - (r.y + r.h / 2),
  };
}

describe('CityScene addBtn centres its label', () => {
  // 1px of slack, no more: this is integer-ish layout maths, not a fuzzy visual budget. The
  // pre-2026-08-30 helper was off by (w/2 - 12 - labelW/2) horizontally — 100+px on a wide button.
  const SLACK = 1;

  it('centres a short label in a wide button instead of pinning it to the left edge', () => {
    const h = host();
    const r = { x: 200, y: 400, w: 320, h: 60 };
    addBtn(h, r.x, r.y, r.w, r.h, 'Go', C.dark, C.paper, () => {});

    const { dx, dy } = offsetFromCentre(labelOf(h), r);
    expect(Math.abs(dx)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(dy)).toBeLessThanOrEqual(SLACK);
  });

  it('keeps a long label centred too, so the button never reads as left-aligned', () => {
    const h = host();
    const r = { x: 0, y: 0, w: 400, h: 56 };
    addBtn(h, r.x, r.y, r.w, r.h, 'Speed Up (1200 coins)', C.dark, C.paper, () => {});

    const { dx } = offsetFromCentre(labelOf(h), r);
    expect(Math.abs(dx)).toBeLessThanOrEqual(SLACK);
  });

  it('sits on the midline at every button height, so nothing is centred against a constant', () => {
    // The vertical half of the bug: `y + (h - 22) / 2` with a top-anchored label lands the text a
    // fixed distance off the midline no matter how tall the button is. Sweeping the heights CityScene
    // actually draws (28/30/32 in the modals, 45 in the queue bar, TEAM_ROW_LABEL_H for Fill All
    // Teams) pins that the offset comes from the label's own measured height instead.
    for (const h of [28, 30, 32, 45, 60, 84]) {
      const host_ = host();
      const r = { x: 100, y: 100, w: 300, h };
      addBtn(host_, r.x, r.y, r.w, r.h, 'Upgrade', C.dark, C.paper, () => {});
      expect(Math.abs(offsetFromCentre(labelOf(host_), r).dy)).toBeLessThanOrEqual(SLACK);
    }
  });

  it('treats a CJK label the same as a Latin one', () => {
    // NOTE ON REACH: the headless harness's text metric is a flat 7px/char and font-size- AND
    // script-independent — `txt('Upgrade')` and `txt('升级')` both measure 14px tall here. So this
    // case pins the *rule* (both scripts land on the midline), not the real-font difference that
    // motivated the fix; a mutation that broke ONLY CJK would not be caught in this harness. The
    // real-font check was a browser screenshot, see UI_DESIGN_LOG_2026-08.md §42.
    const r = { x: 100, y: 100, w: 300, h: 64 };
    const cjk = host();
    addBtn(cjk, r.x, r.y, r.w, r.h, '升级', C.dark, C.paper, () => {});

    const { dx, dy } = offsetFromCentre(labelOf(cjk), r);
    expect(Math.abs(dx)).toBeLessThanOrEqual(SLACK);
    expect(Math.abs(dy)).toBeLessThanOrEqual(SLACK);
  });

  it('still registers a hit rect matching the button it drew', () => {
    // Centring the label must not disturb what is tappable — the label moved, the button did not.
    const h = host();
    const fn = (): void => {};
    addBtn(h, 12, 34, 210, 48, 'Tap', C.dark, C.paper, fn);
    expect(h.hits).toEqual([{ x: 12, y: 34, w: 210, h: 48, fn }]);
  });
});
