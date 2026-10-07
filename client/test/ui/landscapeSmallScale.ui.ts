// Landscape at its own 0.62x target (layout/designSize.ts, 2026-10-07). Below ~670 CSS px of height
// the landscape design is 640–1078 tall instead of 1080, so everything sized `× k` (the battle
// strips and columns, header bars) shrinks while literal design-px things (text tokens, the ten
// hearts, the surrender button, pills sized from their labels) do not. Each block pins one place
// where that mismatch put something off-screen or out of its box on the CrazyGames portal's
// 722x406 preview tile (design 1163x654) — the smallest landscape the review audit looked at.
//
// Runs under the headless PIXI adapter (vitest.ui.config.ts), whose measureText is a flat 7 px per
// character: good enough for the geometry below, which does not branch on glyph widths except where
// noted. Run: npm run test:ui
import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n, setLocale } from '../../src/i18n';
import { setFontScale, resetFontScaleForTest } from '../../src/render/fontScale';
import { createLayout } from '../../src/layout/ScalingManager';
import { landscapeDesignHeight } from '../../src/layout/designSize';
import { InputManager } from '../../src/inputSystem/InputManager';
import { GameRenderer } from '../../src/render/GameRenderer';
import { createLocalMatch } from '../../src/app/matchEngine';
import { getLevel } from '../../src/game';
import { buildCampaignHeader } from '../../src/scenes/CampaignMapScene/header';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

afterEach(() => { resetFontScaleForTest(); setLocale('en'); });

/** The portal preview tile, and the scale ScalingManager would contain it at. */
const VP = { w: 722, h: 406 };
const DESIGN_H = landscapeDesignHeight(VP.h);
const SCALE = VP.h / DESIGN_H;

function battle(): { renderer: GameRenderer; layout: ReturnType<typeof createLayout> } {
  setFontScale(SCALE, DESIGN_H);
  const { engine } = createLocalMatch({ level: getLevel('ch1_lv1')! });
  const layout = createLayout(VP.w, VP.h);
  const renderer = new GameRenderer(engine, layout, new InputManager());
  renderer.init();
  renderer.update(1 / 30);
  return { renderer, layout };
}

describe('landscape at 0.62x — the 722x406 portal tile', () => {
  it('lands on the landscape target scale with a 654-tall design', () => {
    expect(DESIGN_H).toBe(654);
    expect(SCALE).toBeCloseTo(0.62, 2);
  });

  it("the player's ten hearts stay on screen, left of the board", () => {
    const { renderer, layout } = battle();
    const hp = (renderer as any).core.hudView.getPlayerHpRect();
    expect(hp.x).toBeGreaterThanOrEqual(0);
    expect(hp.x + hp.w).toBeLessThanOrEqual(layout.boardRect.x);
    renderer.destroy();
  });

  it('the surrender button fits inside the 36-px top strip', () => {
    const { renderer, layout } = battle();
    const r = (renderer as any).core.hudView.getSurrenderRect();
    expect(r.w).toBeGreaterThan(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
    expect(r.y + r.h).toBeLessThanOrEqual(layout.hudTopRect.y + layout.hudTopRect.h);
    renderer.destroy();
  });

  it('the refresh / upgrade labels are no taller than their buttons', () => {
    const { renderer } = battle();
    const hud = (renderer as any).core.hudView;
    for (const [label, rect] of [[hud.refreshBtnLabel, hud.getRefreshRect()], [hud.upgradeBtnLabel, hud.getUpgradeRect()]]) {
      expect(Number(label.style.fontSize)).toBeLessThanOrEqual(rect.h * 0.8);
    }
    renderer.destroy();
  });

  it('a long card name stays inside the drag ghost', () => {
    const { renderer } = battle();
    const core = (renderer as any).core;
    const slots = core.localPlayer(core.engine.state).hand.slots as Array<{ card: { nameKey: string } } | null>;
    // The longest name in the opening hand: the headless measure is 7 px per character, so any name
    // over 8 characters is wider than the ghost at every size and has to wrap.
    let longest = 0;
    slots.forEach((s, i) => { if (s && s.card.nameKey.length > (slots[longest]?.card.nameKey.length ?? 0)) longest = i; });
    const ghost = core.input.buildCardGhost(longest) as PIXI.Container;
    const name = ghost.children.find((c): c is PIXI.Text => c instanceof PIXI.Text)!;
    const card = ghost.children.find((c): c is PIXI.Graphics => c instanceof PIXI.Graphics)!;
    // Inside the card (the card may widen for one long word; a two-word name wraps instead).
    expect(name.width + 8).toBeLessThanOrEqual(card.getLocalBounds().width);
    expect(card.getLocalBounds().width).toBeLessThan(64 + 40);
    ghost.destroy({ children: true });
    renderer.destroy();
  });
});

describe('campaign header pills at the portal tile', () => {
  it('the Chapters / Gear pills stay inside the header bar', () => {
    setFontScale(SCALE, DESIGN_H);
    const root = new PIXI.Container();
    const hits: { rect: { x: number; y: number; w: number; h: number } }[] = [];
    const barH = buildCampaignHeader(root, hits as never, {
      w: Math.round(DESIGN_H * VP.w / VP.h), h: DESIGN_H, title: 'Chapter 1 · Drill Yard', subtitle: "Tao's notebook",
      onBack() {}, onOpenEquipment() {}, onChapters() {},
    });
    // hits[0] is the back pill; the rest are the shortcut pills.
    expect(hits.length).toBe(3);
    for (const { rect } of hits.slice(1)) {
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y + rect.h).toBeLessThanOrEqual(barH);
    }
    root.destroy({ children: true });
  });
});
