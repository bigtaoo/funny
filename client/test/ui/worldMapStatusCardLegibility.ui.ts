// Coverage for the 2026-08-11 portrait legibility pass (user screenshot: "SLG UI too hard to read
// in portrait"). Two changes to WorldMapPanels' right-column status stack:
//
//   1. The troops/territory status card used to be a single FS.bodyLg sentence
//      ("Troops 8040/10000  Territory 11") crammed into a 56px strip — split into two icon-led
//      stat chips (bigger FS.heading bold value + small caption) so each number reads on its own
//      instead of competing for space in one line (see [[territory-overview-table-cards]]).
//   2. The Battle-replays badge was the one sibling in the action-badge stack still drawn with the
//      low-contrast paper `sketchPanel` (dark text on light paper) while Marches right above it
//      already used the higher-contrast `sketchButton` fill + light text — switched to match.
//
// Same lightweight fake-ctx harness as worldMapBuffRow.ui.ts / worldMapHeaderProduction.ui.ts.
import { describe, it, expect } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { initI18n } from '../../src/i18n';
import { WorldMapPanels } from '../../src/scenes/worldmap/WorldMapPanels';
import { ui as C } from '../../src/render/sketchUi';
import { FS } from '../../src/render/fontScale';
import type { WorldMapContext } from '../../src/scenes/worldmap/WorldMapContext';
import type { PlayerWorldView } from '../../src/net/WorldApiClient';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

const [W, H] = [1000, 700];
const TOP_INSET = 90;

function buildHudHarness(me: Partial<PlayerWorldView> = {}) {
  const ctx = {
    w: W, h: H,
    topInset: TOP_INSET,
    backRect: { x: 0, y: 0, w: 160, h: TOP_INSET },
    hudLayer: new PIXI.Container(),
    headerHudLayer: new PIXI.Container(),
    worldChatLatest: null,
    worldChatUnread: 0,
    zoom: 1 as const,
    me: {
      joined: true, troops: 8040, troopCap: 10000, territoryCount: 11,
      resources: {}, yieldRate: {}, ...me,
    },
    marches: [],
    marchesExpanded: false,
    parseTileId: (id: string) => { const p = id.split(':'); return [Number(p[1]), Number(p[2])]; },
    cb: { accountId: 'me', getCoins: () => 0 },
  } as unknown as WorldMapContext;

  const panels = new WorldMapPanels(ctx);
  return { ctx, panels };
}

function allTexts(root: PIXI.Container): PIXI.Text[] {
  const out: PIXI.Text[] = [];
  for (const child of root.children) {
    if (child instanceof PIXI.Text) out.push(child);
    else if (child instanceof PIXI.Container) out.push(...allTexts(child));
  }
  return out;
}

describe('WorldMapPanels status card — split into two stat chips (2026-08-11)', () => {
  it('troops and territory render as two separate value labels, not one combined sentence', () => {
    const { ctx, panels } = buildHudHarness();
    panels.renderHud();
    const texts = allTexts(ctx.hudLayer).map((t) => t.text);
    // The old implementation joined both into one string like "Troops 8040/10000  Territory 11".
    expect(texts.some((s) => s.includes('Troops') && s.includes('Territory'))).toBe(false);
    expect(texts).toContain('8040/10000');
    expect(texts).toContain('11');
  });

  it('the troops/territory values render at heading size and bold, not the old bodyLg sentence size', () => {
    const { ctx, panels } = buildHudHarness();
    panels.renderHud();
    const valueLbl = allTexts(ctx.hudLayer).find((t) => t.text === '8040/10000');
    expect(valueLbl).toBeTruthy();
    const style = valueLbl!.style as PIXI.TextStyle;
    expect(style.fontSize).toBe(FS.heading);
    expect(style.fontWeight).toBe('bold');
  });

  it('each stat draws a caption below its value (icon + big value + small caption stack)', () => {
    const { ctx, panels } = buildHudHarness();
    panels.renderHud();
    const valueLbl = allTexts(ctx.hudLayer).find((t) => t.text === '8040/10000');
    const captionLbl = allTexts(ctx.hudLayer).find((t) => t.text === 'Territory');
    expect(valueLbl).toBeTruthy();
    expect(captionLbl).toBeTruthy();
    expect(captionLbl!.y).toBeGreaterThan(valueLbl!.y);
  });

  it('Battle Replays badge text is drawn in the light/contrast color, matching the Marches badge above it (was dark-on-paper)', () => {
    const { ctx, panels } = buildHudHarness();
    panels.renderHud();
    const marchesLbl = allTexts(ctx.hudLayer).find((t) => t.text.includes('Marches'));
    const replaysLbl = allTexts(ctx.hudLayer).find((t) => t.text === 'Battle replays');
    expect(marchesLbl).toBeTruthy();
    expect(replaysLbl).toBeTruthy();
    expect((replaysLbl!.style as PIXI.TextStyle).fill).toBe((marchesLbl!.style as PIXI.TextStyle).fill);
    const expectedLight = `#${C.light.toString(16).padStart(6, '0')}`;
    expect((replaysLbl!.style as PIXI.TextStyle).fill).toBe(expectedLight);
  });
});
