// The PixiJS application and its layer stack, created once on module load and shared by every
// module that draws. Split out of index.ts so the entry point is wiring rather than setup.
import * as PIXI from 'pixi.js-legacy';
import { VIEW_W, VIEW_H } from './constants';

export const pixiRoot = document.getElementById('pixi-root')!;
// Aged-paper page background (0xf5f0e8) — the SAME PIXI.Application backgroundColor the game client uses
// (client/src/render/theme.ts palette.paper). This is load-bearing for art parity, NOT cosmetic: the
// terrain atlas is grey pencil on pale paper and impassable tiles (mountain/river) draw at 0.5 alpha so
// they "recede into the paper" (tileStyle.ts TERRAIN_TEX_ALPHA). Over the old dark 0x11111b canvas that
// half-transparency let the dark background bleed through, collapsing the hand-drawn rock/wave art into a
// flat dark blob — which read as "the mountain/river assets aren't showing". A cream page makes them
// render identically to the game (DESIGN.md §6.3 art-parity).
export const app = new PIXI.Application({ width: VIEW_W, height: VIEW_H, backgroundColor: 0xf5f0e8, antialias: true });
pixiRoot.appendChild(app.view as HTMLCanvasElement);

// Screen-fixed ruled-paper backdrop, mirroring the game client's buildPaperBackground('worldmap', …,
// { marginLine: false }) (client/src/scenes/worldmap/WorldMapRenderer/build.ts): faint blue notebook rule
// lines (palette.ruleLine 0xb9cfe4) every ~h/28 px, no red left margin line on the SLG overworld. Added to
// the stage BEFORE worldLayer so it stays fixed while the map pans over it, exactly like the game.
export const paperBg = new PIXI.Graphics();
{
  const lineGap = Math.round(VIEW_H / 28);
  paperBg.lineStyle(1.1, 0xb9cfe4, 1);
  for (let y = lineGap; y < VIEW_H; y += lineGap) {
    paperBg.moveTo(0, y);
    paperBg.lineTo(VIEW_W, y);
  }
}
app.stage.addChild(paperBg);

export const worldLayer = new PIXI.Container();
app.stage.addChild(worldLayer);
export const baseLayer = new PIXI.Container();
baseLayer.sortableChildren = true;
// City building sprites (per-level city_atlas art), between the ground tiles and the vector overlay chrome.
// A child of worldLayer so pans translate it for free; only rebuilt when zoom/seed/city positions change
// (NOT on every terrain-brush tick — cities don't move while painting), see refreshCitySprites().
export const citySpriteLayer = new PIXI.Container();
citySpriteLayer.sortableChildren = true;
export const overlayLayer = new PIXI.Container();
worldLayer.addChild(baseLayer, citySpriteLayer, overlayLayer);
