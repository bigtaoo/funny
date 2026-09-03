// CitySceneCore's shared layout/lookup helpers, extracted as form① free functions (claudedocs/
// client-modules.md "单文件 500 行收敛") — same "no Core delegate, explicit params" shape as
// EquipmentScene/helpers.ts's precedent. drawArtFit/addBtn take a small ArtHost since they write
// into the shared container/hits/artHooked; the rest are pure functions of their arguments.
import * as PIXI from 'pixi.js-legacy';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import type {
  TeamTemplate,
  MarchView,
  OccupationView,
  StationedView,
  PlayerWorldView,
} from '../../net/WorldApiClient';
import { carriedTroops } from '../../game/meta/teamTroops';
import { getArtTexture } from '../../render/cardArt';
import type { Hit } from '../../ui/hits';

/**
 * Where a team currently is, if it isn't sitting at home — mirrors the server's
 * "marching, occupying, or stationed" triple (combatMarch/command.ts's TEAM_BUSY gate).
 *
 * `station` was missing until 2026-08-25: field-stationing (2026-07-23) parks a team on a tile
 * with no march and no occupation doc, so the city team row called every 停留/驻扎 team "驻军在家"
 * even with four squads standing out on the map. Note that a 停留 (mode idle) station is NOT busy
 * — it can be re-commanded in place (see worldmap/net/march.ts) — it just isn't home either, which
 * is exactly what this status line reports.
 */
export function teamOrder(
  marches: MarchView[], occupations: OccupationView[], stationed: StationedView[], teamId: string,
): { march: MarchView } | { occ: OccupationView } | { station: StationedView } | null {
  const march = marches.find((m) => m.mine !== false && m.teamId === teamId);
  if (march) return { march };
  const occ = occupations.find((o) => o.teamId === teamId);
  if (occ) return { occ };
  const station = stationed.find((s) => s.mine !== false && s.teamId === teamId);
  if (station) return { station };
  return null;
}

/** Total troops committed across a team's cards — legacy non-card entries count 0 (see teamTroops.ts). */
export function committedTroops(me: PlayerWorldView | null, army: TeamTemplate['army']): number {
  return carriedTroops(army, me?.cardState);
}

export interface ArtHost {
  /** Where these helpers draw: CityScene's `pageLayer`, not the scene container — the page is the
   *  only layer whose paint mints buttons and portraits. */
  readonly container: PIXI.Container;
  readonly destroyed: boolean;
  readonly artHooked: Set<string>;
  readonly hits: Hit[];
  /** Coalesced repaint (CitySceneCore.requestRender) — a portrait finishing its decode is worth a
   *  frame's wait, and several finishing together are worth exactly one paint between them. */
  requestRender(): void;
}

/** Draw a card portrait centred inside a box; re-render once its texture decodes (mirrors DefenseEditorScene). */
export function drawArtFit(host: ArtHost, url: string, x: number, y: number, boxW: number, boxH: number): void {
  const tex = getArtTexture(url);
  if (!tex.baseTexture.valid) {
    if (!host.artHooked.has(url)) {
      host.artHooked.add(url);
      tex.baseTexture.once('loaded', () => {
        if (!host.destroyed) host.requestRender();
      });
    }
    return;
  }
  const scale = Math.min(boxW / tex.width, boxH / tex.height);
  const sp = new PIXI.Sprite(tex);
  sp.anchor.set(0.5);
  sp.scale.set(scale);
  sp.position.set(x + boxW / 2, y + boxH / 2);
  host.container.addChild(sp);
}

export function addBtn(
  host: ArtHost,
  x: number, y: number, w: number, h: number,
  label: string, textColor: number, fill: number, fn: () => void,
): void {
  const g = sketchPanel(w, h, { fill, border: C.line, width: 1, seed: seedFor(x, y, w) });
  g.x = x;
  g.y = y;
  host.container.addChild(g);
  // Centred, like every other button label in the game (ui/dialogs/confirmDialog, ShopScene/card's
  // drawButton, HubTabs): this used to left-align at `x + 12` and centre vertically against a
  // hardcoded 22px line height rather than the label's measured one, so a short label sat pinned to
  // the left edge of a wide button and a CJK/Latin height difference nudged it off centre.
  const lbl = txt(label, FS.body, textColor, true);
  lbl.anchor.set(0.5, 0.5);
  lbl.x = x + w / 2;
  lbl.y = y + h / 2;
  host.container.addChild(lbl);
  host.hits.push({ rect: { x, y, w, h }, fn });
}

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.floor(n / 1_000)}k`;
  return String(Math.floor(n));
}

export function modalScaleFor(w: number, h: number, mw: number, mh: number): number {
  const ref = Math.min(w, h); // fitted axis — 1080 for both portrait & landscape
  const target = (ref * 0.8) / mw; // popup ≈ 80% of the fitted axis wide (matches old portrait)
  return Math.min(target, (w * 0.92) / mw, (h * 0.92) / mh);
}

/** Convert a rect drawn in the modal's local (unscaled) frame into real screen space. */
export function toScreen(
  r: { x: number; y: number; w: number; h: number },
  originX: number, originY: number, scale: number,
): { x: number; y: number; w: number; h: number } {
  return { x: originX + r.x * scale, y: originY + r.y * scale, w: r.w * scale, h: r.h * scale };
}
