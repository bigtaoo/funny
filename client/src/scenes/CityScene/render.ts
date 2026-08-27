// Page-level rendering for the city scene: header durability, resource bar, build queue,
// building card grid, and the pinned team-slot row along the bottom.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { formatDuration } from '../worldmap/formatDuration';
import { serverNow } from '../../net/serverClock';
import { buildIcon } from '../../render/icons';
import type { BuildingKey } from '../../net/WorldApiClient';
import {
  RESOURCE_TYPES,
  BUILD_SPEEDUP_SECS_PER_COIN,
  DESK_MAX_LEVEL,
  buildingLevel,
  baseDurabilityMax,
  resourceCapFor,
  troopCapFor,
} from '@nw/shared';
import {
  RES_COLORS,
  GRID_BUILDING_KEYS,
  CARD_GAP,
  CARD_W_TARGET,
  CARD_H,
  GRID_PAD,
  MAX_GRID_COLS,
  bldAccentColor,
  chipped,
  producerResource,
} from './core';
import type { CitySceneCore } from './core';
import {
  renderTeamsRow as renderTeamsRowImpl,
  renderTeamCardLoading as renderTeamCardLoadingImpl,
  renderTeamCard as renderTeamCardImpl,
} from './teamRow';

export interface RenderHandlers {
  renderHeaderDurability(headerH: number): void;
  renderTeamsRow(): number;
  renderTeamCard(i: number, x: number, y: number, cardW: number, cardH: number, now: number): void;
  renderTeamCardLoading(i: number, x: number, y: number, cardW: number, cardH: number): void;
  renderResourceBar(startY: number): number;
  renderBuildQueue(startY: number): number;
  renderBuildingGrid(startY: number, bottomY: number): void;
}

export class RenderPanel implements RenderHandlers {
  constructor(private readonly core: CitySceneCore) {}

  // ── Page tabs (D-CITY-11: 内政 / 军事 switch) ────────────────────────────────

  // D-CITY-8: main-base durability — a persistent, self-healing HP bar for the player's own
  // base, capped by the `wall` building's level (baseDurabilityMax). Reads `me.hp`/`me.maxHp`
  // (same field names/semantics as WorldMapView's tile HP bar); falls back to a full bar
  // derived from the current wall level when the server hasn't resolved a main-base anchor yet
  // (e.g. brand-new account mid-joinWorld race). Drawn into the header bar's free right side
  // (the military page it used to have its own panel on was merged away 2026-07-23).
  renderHeaderDurability(headerH: number): void {
    const { w } = this.core;
    const bld = this.core.me?.buildings;
    const maxHp = this.core.me?.maxHp ?? baseDurabilityMax(buildingLevel(bld, 'wall'));
    const hp = this.core.me?.hp ?? maxHp;
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;

    const iconSize = Math.round(headerH * 0.32);
    const barW = Math.round(headerH * 1.4);
    const barH = Math.max(10, Math.round(headerH * 0.11));
    const gap = 10;
    const valLbl = txt(`${this.core.fmtNum(hp)} / ${this.core.fmtNum(maxHp)}`, FS.body, C.mid);

    // Right-aligned cluster: [wall icon] [HP bar] [value]. Lay out right→left off the 16px inset.
    const clusterW = iconSize + gap + barW + gap + valLbl.width;
    const x0 = w - 16 - clusterW;
    const midY = headerH / 2;

    const icon = this.core.bldIcon('wall', iconSize, C.dark);
    icon.x = x0;
    icon.y = midY - iconSize / 2;
    this.core.container.addChild(icon);

    const barX = x0 + iconSize + gap;
    const barY = midY - barH / 2;
    const track = new PIXI.Graphics();
    track.beginFill(0x2a1e12, 0.15);
    track.drawRoundedRect(barX, barY, barW, barH, 3);
    track.endFill();
    this.core.container.addChild(track);

    // Green (healthy) → amber (mid) → red (low) — mirrors the world-map tile HP bar
    // (worldmap/tileGraphics.ts drawHpBar) so the color language is consistent everywhere.
    const fillColor = ratio > 0.5 ? 0x3aa03a : ratio > 0.25 ? 0xd8a520 : 0xcc2222;
    const fill = new PIXI.Graphics();
    fill.beginFill(fillColor, 0.9);
    fill.drawRoundedRect(barX, barY, Math.max(2, barW * ratio), barH, 3);
    fill.endFill();
    this.core.container.addChild(fill);

    valLbl.x = barX + barW + gap;
    valLbl.y = midY - valLbl.height / 2;
    this.core.container.addChild(valLbl);
  }

  // The 5 team slots (D-CITY-10) row + its two per-card renderers are split into ./teamRow.ts
  // (form ① free functions) purely to keep this file under the 500-line convention — they have no
  // life of their own outside this dispatch, so they take `core` explicitly instead of becoming a
  // fourth domain class.
  renderTeamsRow(): number {
    return renderTeamsRowImpl(this.core);
  }

  renderTeamCardLoading(i: number, x: number, y: number, cardW: number, cardH: number): void {
    renderTeamCardLoadingImpl(this.core, i, x, y, cardW, cardH);
  }

  renderTeamCard(i: number, x: number, y: number, cardW: number, cardH: number, now: number): void {
    renderTeamCardImpl(this.core, i, x, y, cardW, cardH, now);
  }

  // ── Resource bar ──────────────────────────────────────────────────────────

  renderResourceBar(startY: number): number {
    const cx0 = this.core.contentX;
    const w = this.core.w - cx0;
    const bld = this.core.me?.buildings;

    const panH = 108;
    const pg = sketchPanel(w - 16, panH, {
      fill: C.paper,
      border: C.mid,
      width: 1,
      seed: seedFor(w, panH, 3),
    });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.core.container.addChild(pg);

    const cellW = Math.floor((w - 16) / 5);
    RESOURCE_TYPES.forEach((rt, i) => {
      const cx = cx0 + 8 + i * cellW;
      const cap = resourceCapFor(bld);
      // Actual hourly production (server-computed: tile yield × building mult + self-yield + BP),
      // not the raw building multiplier — this is the "产量" the player cares about.
      const rate = Math.round(this.core.me?.yieldRate?.[rt] ?? 0);

      // Color accent bar
      const ab = new PIXI.Graphics();
      ab.beginFill(RES_COLORS[rt], 0.45);
      ab.drawRect(cx + 9, startY + 6, cellW - 18, 10);
      ab.endFill();
      this.core.container.addChild(ab);

      const icon = chipped(33, RES_COLORS[rt], (n) => this.core.resIcon(rt, n));
      icon.x = cx + 12;
      icon.y = startY + 24;
      this.core.container.addChild(icon);

      // Live total: grown client-side from the last fetch (tickResourceTotals updates it per second).
      const curLbl = txt(this.core.fmtNum(this.core.liveResource(rt)), FS.label, C.dark, true);
      curLbl.x = cx + 52;
      curLbl.y = startY + 24;
      this.core.container.addChild(curLbl);
      this.core.resTotalLbls.push({ rt, lbl: curLbl });

      const capLbl = txt(`/${this.core.fmtNum(cap)}`, FS.small, C.mid);
      capLbl.x = cx + 12;
      capLbl.y = startY + 62;
      this.core.container.addChild(capLbl);

      const yldLbl = txt(
        `+${this.core.fmtNum(rate)}/h`,
        FS.small,
        rate > 0 ? RES_COLORS[rt] : C.mid
      );
      yldLbl.x = cx + 12;
      yldLbl.y = startY + 84;
      this.core.container.addChild(yldLbl);
    });

    return startY + panH + 4;
  }

  // ── Build queue ───────────────────────────────────────────────────────────

  renderBuildQueue(startY: number): number {
    const cx0 = this.core.contentX;
    const w = this.core.w - cx0;
    const queue = this.core.me?.buildQueue ?? [];
    const now = serverNow();

    const panH = queue.length > 0 ? 72 : 51;
    const pg = sketchPanel(w - 16, panH, {
      fill: C.paper,
      border: C.mid,
      width: 1,
      seed: seedFor(w, panH, 5),
    });
    pg.x = cx0 + 8;
    pg.y = startY;
    this.core.container.addChild(pg);

    const hdr = txt(t('city.buildQueue'), FS.body, C.mid, true);
    hdr.x = cx0 + 24;
    hdr.y = startY + 14;
    this.core.container.addChild(hdr);

    if (queue.length === 0) {
      const empty = txt(t('city.queueEmpty'), FS.body, C.mid);
      empty.x = cx0 + 195;
      empty.y = startY + 14;
      this.core.container.addChild(empty);
    } else {
      const entry = queue[0]!;
      const secsLeft = Math.max(0, Math.ceil((entry.completeAt - now) / 1000));
      const name = t(`city.bld.${entry.key}` as 'city.bld.desk');
      const label = t('city.queueEntry')
        .replace('{name}', name)
        .replace('{to}', String(entry.toLevel))
        .replace('{sec}', formatDuration(secsLeft));

      const entryLbl = txt(label, FS.bodyLg, C.dark, true);
      entryLbl.x = cx0 + 195;
      entryLbl.y = startY + 14;
      this.core.container.addChild(entryLbl);

      if (secsLeft > 0) {
        const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
        const speedLabel = t('city.speedup').replace('{coins}', String(coins));
        this.core.addBtn(
          cx0 + w - 249,
          startY + 9,
          228,
          45,
          speedLabel,
          0xffffff,
          C.gold,
          () => void this.core.doSpeedup(entry.key)
        );
      }
    }

    return startY + panH + 4;
  }

  // ── Building grid ─────────────────────────────────────────────────────────

  /** @param bottomY hard lower bound for the grid's viewport — the top of the pinned team row. */
  renderBuildingGrid(startY: number, bottomY: number): void {
    const cx0 = this.core.contentX;
    const w = this.core.w - cx0;
    const bld = this.core.me?.buildings;
    // Grid tiles = every building (incl. academy/tech-tree) plus a synthetic "Train Troops" action
    // tile spliced in right after drillYard (sibling to it, not nested in its modal). Training feeds
    // the unified troop pool.
    const tiles: Array<{ kind: 'bld'; key: BuildingKey } | { kind: 'train' }> = [];
    for (const key of GRID_BUILDING_KEYS) {
      tiles.push({ kind: 'bld', key });
      if (key === 'drillYard') tiles.push({ kind: 'train' });
    }

    const availW = w - GRID_PAD * 2;
    const cols = Math.min(
      MAX_GRID_COLS,
      Math.max(1, Math.floor((availW + CARD_GAP) / (CARD_W_TARGET + CARD_GAP)))
    );
    const cellW = Math.floor((availW - (cols - 1) * CARD_GAP) / cols);
    const rows = Math.ceil(tiles.length / cols);
    const contentH = rows * CARD_H + (rows - 1) * CARD_GAP;

    const viewY = startY;
    const availH = Math.max(0, bottomY - viewY);
    // Clamp so overflow always cuts mid-row, leaving a partial next card peeking above the fold.
    const viewH = peekViewportH(availH, CARD_H + CARD_GAP, contentH);
    this.core.scrollMax = Math.max(0, contentH - viewH);
    if (this.core.scrollY > this.core.scrollMax) this.core.scrollY = this.core.scrollMax;
    this.core.regionTop = viewY;
    this.core.regionBottom = viewY + viewH;

    const gridLayer = new PIXI.Container();
    gridLayer.x = cx0;
    gridLayer.y = viewY - this.core.scrollY;
    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRect(cx0, viewY, w, viewH).endFill();
    this.core.container.addChild(maskG);
    gridLayer.mask = maskG;
    this.core.container.addChild(gridLayer);

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
      const cy = row * (CARD_H + CARD_GAP);
      const cullY = viewY - this.core.scrollY + cy;
      if (cullY + CARD_H < viewY - cullBuffer || cullY > viewY + viewH + cullBuffer) return;

      // "Active" ring: a queued build for buildings, or an in-progress training batch for the train tile.
      const active =
        tile.kind === 'bld'
          ? (this.core.me?.buildQueue ?? []).some((q) => q.key === tile.key)
          : (this.core.me?.trainingQueue?.length ?? 0) > 0;
      // Not-yet-built (Lv.0) buildings read identically to a maxed-out one at a glance — dim them
      // and swap the queue-hammer badge for a "+" build prompt so the grid tells the two apart
      // without reading every "Lv.N" line. A queued build (active) already answers "yes, working on
      // it", so it takes priority over the dimmed/unbuilt treatment.
      const unbuilt = tile.kind === 'bld' && buildingLevel(bld, tile.key) === 0;
      const dim = unbuilt && !active;

      const bg = sketchPanel(cellW, CARD_H, {
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
          ? Math.max(0, Math.min(1, (this.core.me?.troops ?? 0) / troopCapFor(bld)))
          : 0;
      const barX = cx + 9;
      const barW = cellW - 18;
      const barTrack = new PIXI.Graphics();
      barTrack.beginFill(accent, 0.18);
      barTrack.drawRoundedRect(barX, cy + 118, barW, 6, 3);
      barTrack.endFill();
      gridLayer.addChild(barTrack);
      const barFill = new PIXI.Graphics();
      barFill.beginFill(accent, 0.85);
      barFill.drawRoundedRect(barX, cy + 118, Math.max(3, barW * ratio), 6, 3);
      barFill.endFill();
      gridLayer.addChild(barFill);

      // Chip only the five producer cards — their glyph IS a resource motif, an open outline that
      // needs a ground, and the tint says which resource. The hand-drawn bld_* art is dense enough to
      // read on bare paper and a chip behind it only crops and muddies it (see icons.ts CHIP_INSET).
      const producer = tile.kind === 'bld' ? producerResource(tile.key) : undefined;
      const drawGlyph = (n: number): PIXI.DisplayObject =>
        tile.kind === 'bld' ? this.core.bldIcon(tile.key, n, C.dark) : buildIcon('armor', n, C.dark);
      const icon = producer ? chipped(60, accent, drawGlyph) : drawGlyph(60);
      icon.x = cx + (cellW - 60) / 2;
      icon.y = cy + 18;
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
      const nameLbl = txt(name, FS.body, C.dark, true, cellW - 18);
      nameLbl.x = cx + 9;
      nameLbl.y = cy + 90;
      nameLbl.alpha = dim ? 0.55 : 1;
      gridLayer.addChild(nameLbl);

      // Buildings show a level; the train tile shows the current troop pool / cap instead.
      const subtitle =
        tile.kind === 'bld'
          ? t('city.lvlLabel').replace('{lvl}', String(buildingLevel(bld, tile.key)))
          : t('city.troopCap')
              .replace('{cur}', String(this.core.me?.troops ?? 0))
              .replace('{cap}', String(troopCapFor(bld)));
      const subLbl = txt(subtitle, FS.body, C.mid, false, cellW - 18);
      subLbl.x = cx + 9;
      subLbl.y = cy + CARD_H - 33;
      subLbl.alpha = dim ? 0.55 : 1;
      gridLayer.addChild(subLbl);

      if (active) {
        const qDot = buildIcon('hammer', 24, C.gold);
        qDot.x = cx + cellW - 36;
        qDot.y = cy + 12;
        gridLayer.addChild(qDot);
      } else if (unbuilt) {
        const badgeR = 13;
        const bx = cx + cellW - 12 - badgeR;
        const by = cy + 12 + badgeR;
        const badge = new PIXI.Graphics();
        badge.lineStyle(1.5, C.mid, 0.9);
        badge.beginFill(C.paper, 1);
        badge.drawCircle(bx, by, badgeR);
        badge.endFill();
        gridLayer.addChild(badge);
        const plus = txt('+', FS.bodyLg, C.mid, true);
        plus.x = bx - plus.width / 2;
        plus.y = by - plus.height / 2 - 1;
        gridLayer.addChild(plus);
      }

      // Hit rect in absolute screen space (gridLayer's local `cy` + its own viewY/scroll offset) —
      // only reachable while the card is actually within the visible viewport.
      const screenY = viewY - this.core.scrollY + cy;
      if (screenY + CARD_H > viewY && screenY < viewY + viewH) {
        const cardRect = { x: cx0 + cx, y: screenY, w: cellW, h: CARD_H };
        // SLG opening guide chain step2 (ONBOARDING_DESIGN §4.2): highlight the very first grid card
        // until any card/train tile is opened. CityScene.ts's own header block leaves the guide alone
        // whenever step2 is still pending — this is the only call that decides its content in that case.
        if (i === 0 && !(this.core.cb.getFlag?.('guide.world.step2') ?? false)) {
          this.core.guide.showAt(cardRect, t('guide.world.step2.body'), { w: this.core.w, h: this.core.h }, {
            onSkip: () => this.core.cb.setFlag?.('guide.world.step2', true),
          });
        }
        this.core.hits.push({
          ...cardRect,
          fn:
            tile.kind === 'bld'
              ? () => {
                  this.core.cb.setFlag?.('guide.world.step2', true);
                  this.core.selectedBuilding = tile.key;
                  this.core.render();
                }
              : () => {
                  this.core.cb.setFlag?.('guide.world.step2', true);
                  this.core.selectedTrain = true;
                  this.core.render();
                },
        });
      }
    });

    drawScrollIndicator(
      this.core.container,
      { x: cx0, y: viewY, w, h: viewH },
      this.core.scrollY,
      this.core.scrollMax
    );
  }
}
