// The home-city building grid — split out of ./render.ts (2026-09-11, form ① independent function
// module per claudedocs/client-modules.md's split-form priority note) when the portrait fill rule
// (./gridMetrics.ts) pushed render.ts past the 500-line convention. Same shape as ./teamRow.ts: it
// is only ever called from RenderPanel.renderBuildingGrid and takes `core` explicitly rather than
// becoming a fourth domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { buildIcon } from '../../render/icons';
import type { BuildingKey } from '../../net/WorldApiClient';
import { DESK_MAX_LEVEL, buildingLevel, troopCapFor } from '@nw/shared';
import {
  GRID_BUILDING_KEYS, CARD_GAP, CARD_W_TARGET, CARD_H, GRID_PAD, MAX_GRID_COLS,
  bldAccentColor, chipped, producerResource,
} from './core';
import type { CitySceneCore } from './core';
import { gridMetrics, CARD_LAYOUT } from './gridMetrics';

/**
 * The scrollable card grid of every building (plus the synthetic "Train Troops" tile), drawn into
 * the band between the build-queue strip and the pinned team row.
 *
 * @param bottomY hard lower bound for the grid's viewport — the top of the pinned team row.
 */
export function renderBuildingGrid(core: CitySceneCore, startY: number, bottomY: number): void {
  const cx0 = core.contentX;
  const w = core.w - cx0;
  const bld = core.me?.buildings;
  // Grid tiles = every building (incl. academy/tech-tree) plus a synthetic "Train Troops" action
  // tile spliced in right after drillYard (sibling to it, not nested in its modal). Training feeds
  // the unified troop pool.
  const tiles: Array<{ kind: 'bld'; key: BuildingKey } | { kind: 'train' }> = [];
  for (const key of GRID_BUILDING_KEYS) {
    tiles.push({ kind: 'bld', key });
    if (key === 'drillYard') tiles.push({ kind: 'train' });
  }

  const availW = w - GRID_PAD * 2;
  const viewY = startY;
  const availH = Math.max(0, bottomY - viewY);
  // Columns and card height both come from ./gridMetrics.ts: landscape keeps the historical
  // "as many CARD_W_TARGET columns as fit, CARD_H tall", portrait derives the height from the
  // band so the grid fills it instead of leaving half a screen of blank paper below itself.
  const { cols, cellW, cardH, topPad } = gridMetrics({
    count: tiles.length,
    availW,
    availH,
    gap: CARD_GAP,
    cardH: CARD_H,
    cardWTarget: CARD_W_TARGET,
    maxCols: MAX_GRID_COLS,
    portrait: core.portrait,
  });
  const rows = Math.ceil(tiles.length / cols);
  const contentH = topPad + rows * cardH + (rows - 1) * CARD_GAP;
  // Type grows with the card: a 415-tall portrait card carrying the flat 18px body label reads as
  // an empty frame. The fraction is `FS.body / CARD_H`, so the classic 192-tall card comes out at
  // exactly the body size this replaces (landscape is bit-for-bit unchanged); `snapFont` keeps a
  // grown card on the shared scale, and the `label` ceiling stops a tall one turning its name
  // into a heading.
  const cardFS = Math.min(snapFont(cardH * (18 / 192)), FS.label);
  // Clamp so overflow always cuts mid-row, leaving a partial next card peeking above the fold.
  const viewH = peekViewportH(availH, cardH + CARD_GAP, contentH);
  core.scrollMax = Math.max(0, contentH - viewH);
  if (core.scrollY > core.scrollMax) core.scrollY = core.scrollMax;
  core.regionTop = viewY;
  core.regionBottom = viewY + viewH;

  const gridLayer = new PIXI.Container();
  gridLayer.x = cx0;
  gridLayer.y = viewY - core.scrollY;
  const maskG = new PIXI.Graphics();
  maskG.beginFill(0xffffff).drawRect(cx0, viewY, w, viewH).endFill();
  core.paint.pageLayer.addChild(maskG);
  gridLayer.mask = maskG;
  core.paint.pageLayer.addChild(gridLayer);

  // Viewport cull (2026-08-12, same fix as BattlePassScene/LeaderboardScene/ChatScene/
  // DeckBuilderScene): GRID_BUILDING_KEYS is a fixed ~11-entry list today, never a crash risk in
  // practice — but it's the same missing-cull shape (every tile's panel+bars+icon+2 Text got
  // built unconditionally regardless of scroll position). Core has no reposition-only drag fast
  // path (scrollDirty triggers a full render() per drag frame, see core.ts), so a plain
  // skip-if-off-screen check here is enough — no cross-render object cache needed.
  const cullBuffer = viewH * 0.5;
  tiles.forEach((tile, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = GRID_PAD + col * (cellW + CARD_GAP);
    // Local to gridLayer (which is itself offset by viewY - scrollY), so this is NOT absolute screen space.
    const cy = topPad + row * (cardH + CARD_GAP);
    const cullY = viewY - core.scrollY + cy;
    if (cullY + cardH < viewY - cullBuffer || cullY > viewY + viewH + cullBuffer) return;

    // "Active" ring: a queued build for buildings, or an in-progress training batch for the train tile.
    const active =
      tile.kind === 'bld'
        ? (core.me?.buildQueue ?? []).some((q) => q.key === tile.key)
        : (core.me?.trainingQueue?.length ?? 0) > 0;
    // Not-yet-built (Lv.0) buildings read identically to a maxed-out one at a glance — dim them
    // and swap the queue-hammer badge for a "+" build prompt so the grid tells the two apart
    // without reading every "Lv.N" line. A queued build (active) already answers "yes, working on
    // it", so it takes priority over the dimmed/unbuilt treatment.
    const unbuilt = tile.kind === 'bld' && buildingLevel(bld, tile.key) === 0;
    const dim = unbuilt && !active;

    const bg = sketchPanel(cellW, cardH, {
      fill: C.paper,
      border: active ? C.gold : C.mid,
      width: active ? 2 : 1,
      seed: seedFor(cx, cy, i),
    });
    bg.x = cx;
    bg.y = cy;
    gridLayer.addChild(bg);

    // Category-accent level stripe (2026-08-01): ties producer cards to the resource bar's own
    // color language above them and gives the rest a category tint, so the grid reads as groups
    // instead of one undifferentiated row of look-alike cards. Filled portion = progress toward
    // the card's current ceiling — desk's own DESK_MAX_LEVEL, everyone else gated by desk's level
    // (city.ts buildGateReason) — for the train tile, carried troops against the trained-troop cap.
    const accent = bldAccentColor(tile.kind === 'bld' ? tile.key : 'drillYard');
    const ratio =
      tile.kind === 'bld'
        ? Math.max(
            0,
            Math.min(
              1,
              buildingLevel(bld, tile.key) /
                (tile.key === 'desk' ? DESK_MAX_LEVEL : Math.max(1, buildingLevel(bld, 'desk')))
            )
          )
        : troopCapFor(bld) > 0
        ? Math.max(0, Math.min(1, (core.me?.troops ?? 0) / troopCapFor(bld)))
        : 0;
    const barX = cx + 9;
    const barW = cellW - 18;
    // Every offset inside the card is a fraction of its height (./gridMetrics.ts CARD_LAYOUT), so
    // the composition is the same one the fixed 192-tall card was drawn with at any card size.
    const barY = cy + Math.round(cardH * CARD_LAYOUT.barY);
    const barH = Math.max(6, Math.round(cardH * CARD_LAYOUT.barH));
    const barTrack = new PIXI.Graphics();
    barTrack.beginFill(accent, 0.18);
    barTrack.drawRoundedRect(barX, barY, barW, barH, 3);
    barTrack.endFill();
    gridLayer.addChild(barTrack);
    const barFill = new PIXI.Graphics();
    barFill.beginFill(accent, 0.85);
    barFill.drawRoundedRect(barX, barY, Math.max(3, barW * ratio), barH, 3);
    barFill.endFill();
    gridLayer.addChild(barFill);

    // Chip only the five producer cards — their glyph IS a resource motif, an open outline that
    // needs a ground, and the tint says which resource. The hand-drawn bld_* art is dense enough to
    // read on bare paper and a chip behind it only crops and muddies it (see icons.ts CHIP_INSET).
    const producer = tile.kind === 'bld' ? producerResource(tile.key) : undefined;
    const drawGlyph = (n: number): PIXI.DisplayObject =>
      tile.kind === 'bld' ? core.bldIcon(tile.key, n, C.dark) : buildIcon('armor', n, C.dark);
    const iconSize = Math.round(cardH * CARD_LAYOUT.iconSize);
    const icon = producer ? chipped(iconSize, accent, drawGlyph) : drawGlyph(iconSize);
    icon.x = cx + (cellW - iconSize) / 2;
    icon.y = cy + Math.round(cardH * CARD_LAYOUT.iconTop);
    // Unbuilt used to sit at 0.4, which was set when every glyph read strongly. On the two producer
    // cards whose motif was already the faintest on the page (paper, graphite — the ones circled in
    // the report) it multiplied out to nothing at all: a Lv.0 石墨坊 was a blank card. 0.65 still
    // reads as "not yet", and the "+" badge and the greyed name carry that message anyway.
    icon.alpha = dim ? 0.65 : 1;
    gridLayer.addChild(icon);

    const name =
      tile.kind === 'bld'
        ? t(`city.bld.${tile.key}` as 'city.bld.desk')
        : t('city.bld.trainTroops');
    const nameLbl = txt(name, cardFS, C.dark, true, cellW - 18);
    nameLbl.x = cx + 9;
    nameLbl.y = cy + Math.round(cardH * CARD_LAYOUT.nameY);
    nameLbl.alpha = dim ? 0.55 : 1;
    gridLayer.addChild(nameLbl);

    // Buildings show a level; the train tile shows the current troop pool / cap instead.
    const subtitle =
      tile.kind === 'bld'
        ? t('city.lvlLabel').replace('{lvl}', String(buildingLevel(bld, tile.key)))
        : t('city.troopCap')
            .replace('{cur}', String(core.me?.troops ?? 0))
            .replace('{cap}', String(troopCapFor(bld)));
    const subLbl = txt(subtitle, cardFS, C.mid, false, cellW - 18);
    subLbl.x = cx + 9;
    subLbl.y = cy + cardH - Math.round(cardH * CARD_LAYOUT.subFromBottom) - subLbl.height / 2;
    subLbl.alpha = dim ? 0.55 : 1;
    gridLayer.addChild(subLbl);

    if (active) {
      const qSize = Math.max(24, Math.round(cardH * CARD_LAYOUT.queueIcon));
      const qDot = buildIcon('hammer', qSize, C.gold);
      qDot.x = cx + cellW - 12 - qSize;
      qDot.y = cy + 12;
      gridLayer.addChild(qDot);
    } else if (unbuilt) {
      const badgeR = Math.max(13, Math.round(cardH * CARD_LAYOUT.badgeR));
      const bx = cx + cellW - 12 - badgeR;
      const by = cy + 12 + badgeR;
      const badge = new PIXI.Graphics();
      badge.lineStyle(1.5, C.mid, 0.9);
      badge.beginFill(C.paper, 1);
      badge.drawCircle(bx, by, badgeR);
      badge.endFill();
      gridLayer.addChild(badge);
      const plus = txt('+', snapFont(badgeR * 1.5), C.mid, true);
      plus.x = bx - plus.width / 2;
      plus.y = by - plus.height / 2 - 1;
      gridLayer.addChild(plus);
    }

    // Hit rect in absolute screen space (gridLayer's local `cy` + its own viewY/scroll offset) —
    // only reachable while the card is actually within the visible viewport.
    const screenY = viewY - core.scrollY + cy;
    if (screenY + cardH > viewY && screenY < viewY + viewH) {
      const cardRect = { x: cx0 + cx, y: screenY, w: cellW, h: cardH };
      // SLG opening guide chain step2 (ONBOARDING_DESIGN §4.2): the very first grid card is the
      // ring's target until any card/train tile is opened. Only the RECT is recorded here —
      // CityScene.ts's paintPage owns the whole show/hide decision (and has to be able to replay
      // it after a modal closes, when this grid is not being repainted at all).
      if (i === 0) core.paint.guideStep2 = cardRect;
      core.hits.push({
        rect: cardRect,
        fn:
          tile.kind === 'bld'
            // paintModal, not render: opening a modal changes nothing on the page behind it, so
            // the page layer stays exactly as it is and only the modal layer is built.
            ? () => {
                core.cb.setFlag?.('guide.world.step2', true);
                core.selectedBuilding = tile.key;
                core.paintModal();
              }
            : () => {
                core.cb.setFlag?.('guide.world.step2', true);
                core.selectedTrain = true;
                core.paintModal();
              },
      });
    }
  });

  drawScrollIndicator(
    core.paint.pageLayer,
    { x: cx0, y: viewY, w, h: viewH },
    core.scrollY,
    core.scrollMax
  );
}
