// The "N games today without ELO loss" sticker on the lobby's START MATCH hero (SEASON_DESIGN_IMPL_SPEC.md
// §15.5, LobbyScene/protectSticker.ts): new-player slots left + daily slots left. Pins that it
//   * shows only online with a positive count (hidden at 0 and offline);
//   * sits inside the screen, below the header band, inside the hero's horizontal span;
//   * keeps its label inside its own tag and overlaps no other text in the lobby (START MATCH, the
//     "Ranked · …" sub line, header chips) — in every locale, portrait and landscape, including the
//     boosted-font case a small phone gets (setFontScale(406/1080));
//   * is singular-aware ("1 game") and survives a lobby rebuild.
//
// Runs under the headless PIXI adapter (test/harness/pixiHeadless.ts via vitest.ui.config.ts).
// Run: npm run test:ui

import { describe, it, expect, afterEach } from 'vitest';
import * as PIXI from 'pixi.js-legacy';
import { createLayout } from '../../src/layout/ScalingManager';
import { InputManager } from '../../src/inputSystem/InputManager';
import { initI18n, setLocale, t, type Locale } from '../../src/i18n';
import { setFontScale, resetFontScaleForTest } from '../../src/render/fontScale';
import { LobbyScene } from '../../src/scenes/LobbyScene';
import { headerMetrics } from '../../src/scenes/LobbyScene/format';
import { protectedGamesLeftToday } from '../../src/game/meta/eloProtect';

const memStore = (() => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string): string | null => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string): void => { m.set(k, v); },
    removeItem: (k: string): void => { m.delete(k); },
  };
})();
initI18n('en', memStore, ['zh', 'en', 'de']);

afterEach(() => {
  resetFontScaleForTest();
  setLocale('en');
});

interface Rect { x: number; y: number; w: number; h: number }
interface CoreView {
  w: number;
  h: number;
  portrait: boolean;
  btnRect: Rect;
  protectStickerRect: Rect | null;
  rebuild(): void;
}

function build(left: number, opts: { online?: boolean; w?: number; h?: number } = {}): { scene: LobbyScene; core: CoreView } {
  const noop = (): void => {};
  const scene = new LobbyScene(createLayout(opts.w ?? 800, opts.h ?? 1280), new InputManager(), {
    onStartGame: noop, onOpenCampaign: noop, onOpenRoom: noop, onOpenShop: noop,
    onOpenCards: noop, onOpenStats: noop, onOpenProfile: noop,
    playerName: 'Tester',
    online: opts.online ?? true,
    onStartRanked: noop,
    onOpenDaily: noop,
    onOpenMail: noop,
    onOpenWorld: noop,
    pvp: { rank: 'gold', elo: 1400 },
    getCoins: () => 12345,
    getProtectedGamesLeft: () => left,
  });
  return { scene, core: (scene as unknown as { core: CoreView }).core };
}

function texts(root: PIXI.Container, skip: PIXI.Container | undefined): Array<{ text: string; b: PIXI.Rectangle }> {
  const out: Array<{ text: string; b: PIXI.Rectangle }> = [];
  const walk = (n: PIXI.Container): void => {
    for (const ch of n.children) {
      if (ch === skip || !ch.visible) continue;
      if (ch instanceof PIXI.Text) { if (ch.text.trim()) out.push({ text: ch.text, b: ch.getBounds() }); continue; }
      if (ch instanceof PIXI.Container) walk(ch);
    }
  };
  walk(root);
  return out;
}

const overlaps = (a: Rect, b: PIXI.Rectangle): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.w && a.y < b.y + b.height && b.y < a.y + a.h;

const stickerLayer = (scene: LobbyScene): PIXI.Container | undefined =>
  scene.container.children.find((c) => c.name === 'lobby:protectSticker') as PIXI.Container | undefined;

describe('lobby protect sticker - layout', () => {
  // Same viewport set as lobbyEntryNotice.ui.ts: tall/short portrait, wide/short landscape, tiny landscape.
  const sizes: [number, number][] = [[800, 1280], [1170, 2532], [375, 812], [1568, 744], [722, 406]];
  const scales: Array<[string, number | null]> = [['base', null], ['font-boost', 406 / 1080]];
  for (const loc of ['zh', 'en', 'de'] as Locale[]) {
    for (const [vw, vh] of sizes) for (const [scaleName, scale] of scales) {
      it(`[${loc}] ${vw}x${vh} ${scaleName}: on screen, below the header, inside the hero span, overlapping no text`, () => {
        setLocale(loc);
        if (scale !== null) setFontScale(scale);
        const { scene, core } = build(6, { w: vw, h: vh });
        const r = core.protectStickerRect;
        expect(r, 'sticker should be drawn for 6 games left').not.toBeNull();
        const layer = stickerLayer(scene)!;
        expect(layer).toBeDefined();
        const where = `${loc} ${vw}x${vh} ${scaleName}`;
        expect(r!.x, `${where}: left edge`).toBeGreaterThanOrEqual(core.btnRect.x);
        expect(r!.x + r!.w, `${where}: right edge`).toBeLessThanOrEqual(core.btnRect.x + core.btnRect.w);
        expect(r!.y, `${where}: must stay below the header band`).toBeGreaterThanOrEqual(headerMetrics(core.w, core.h, core.portrait).tbH);
        expect(r!.y + r!.h, `${where}: must not reach the START MATCH label row`).toBeLessThan(core.btnRect.y + core.btnRect.h * 0.5);
        // Its own label stays inside the tag.
        const label = layer.children.find((c): c is PIXI.Text => c instanceof PIXI.Text)!;
        expect(label.text).toBe(t('lobby.protectLeft', { n: 6 }));
        // getBounds() includes the text style's transparent glyph padding (makeText); compare the ink box.
        const pad = Number((label.style as PIXI.TextStyle).padding ?? 0) * label.scale.x;
        const raw = label.getBounds();
        const lb = new PIXI.Rectangle(raw.x + pad, raw.y + pad, raw.width - 2 * pad, raw.height - 2 * pad);
        expect(lb.x, `${where}: label left`).toBeGreaterThanOrEqual(r!.x - 0.5);
        expect(lb.x + lb.width, `${where}: label right`).toBeLessThanOrEqual(r!.x + r!.w + 0.5);
        expect(lb.y, `${where}: label top`).toBeGreaterThanOrEqual(r!.y - 0.5);
        expect(lb.y + lb.height, `${where}: label bottom`).toBeLessThanOrEqual(r!.y + r!.h + 0.5);
        // No other text in the lobby under it (START MATCH, sub line, header chips, nav labels…).
        for (const other of texts(scene.container, layer)) {
          expect(overlaps(r!, other.b), `${where}: overlaps "${other.text}"`).toBe(false);
        }
        scene.destroy();
      });
    }
  }
});

describe('lobby protect sticker - visibility', () => {
  it('is hidden when no protected game is left today', () => {
    const { scene, core } = build(0);
    expect(core.protectStickerRect).toBeNull();
    expect(stickerLayer(scene)).toBeUndefined();
    scene.destroy();
  });

  it('is hidden offline even with a count', () => {
    const { scene, core } = build(3, { online: false });
    expect(core.protectStickerRect).toBeNull();
    scene.destroy();
  });

  it('uses the singular for one game and survives a rebuild', () => {
    const { scene, core } = build(1);
    const label = stickerLayer(scene)!.children.find((c): c is PIXI.Text => c instanceof PIXI.Text)!;
    expect(label.text).toBe(t('lobby.protectLeftOne'));
    core.rebuild();
    expect(core.protectStickerRect).not.toBeNull();
    expect(scene.container.children.filter((c) => c.name === 'lobby:protectSticker')).toHaveLength(1);
    scene.destroy();
  });
});

describe('protectedGamesLeftToday (client mirror of ladder.ts protectedGamesLeft)', () => {
  const NOW = Date.UTC(2026, 9, 7, 15, 0, 0);
  it('adds new-player slots left to today\'s daily slots left; another day\'s counter reads as unused', () => {
    expect(protectedGamesLeftToday({ wins: 0, losses: 0 }, NOW)).toBe(6);
    expect(protectedGamesLeftToday({ wins: 1, losses: 1 }, NOW)).toBe(4);
    expect(protectedGamesLeftToday({ wins: 2, losses: 2, dailyProtect: { dayKey: '2026-10-07', used: 1 } }, NOW)).toBe(2);
    expect(protectedGamesLeftToday({ wins: 9, losses: 9, dailyProtect: { dayKey: '2026-10-07', used: 3 } }, NOW)).toBe(0);
    expect(protectedGamesLeftToday({ wins: 9, losses: 9, dailyProtect: { dayKey: '2026-10-06', used: 3 } }, NOW)).toBe(3);
  });
});
