// Page-level rendering for the city scene: header durability, resource bar, build queue,
// building card grid, and the pinned team-slot row along the bottom.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { formatDuration } from '../worldmap/logic/formatDuration';
import { serverNow } from '../../net/serverClock';
import {
  RESOURCE_TYPES,
  BUILD_SPEEDUP_SECS_PER_COIN,
  buildingLevel,
  baseDurabilityMax,
  resourceCapFor,
} from '@nw/shared';
import { RES_COLORS, chipped } from './core';
import type { CitySceneCore } from './core';
import { renderBuildingGrid as renderBuildingGridImpl } from './buildingGrid';
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
  /**
   * Width the durability cluster needs, so the scene can hand it to `drawSceneHeader` as
   * `rightReserve` BEFORE the title is laid out. Without the reserve the header centres its title
   * across the whole bar and the cluster is drawn on top of it afterwards — in portrait the bar is
   * narrow enough that the HP bar ran straight through "Home City" (measured 2026-09-11).
   */
  headerDurabilityWidth(headerH: number): number {
    const m = this.durabilityMetrics(headerH);
    m.valLbl.destroy();
    return m.clusterW;
  }

  private durabilityMetrics(headerH: number): {
    iconSize: number; barW: number; barH: number; gap: number; clusterW: number; valLbl: PIXI.Text;
    hp: number; maxHp: number; ratio: number;
  } {
    const bld = this.core.me?.buildings;
    const maxHp = this.core.me?.maxHp ?? baseDurabilityMax(buildingLevel(bld, 'wall'));
    const hp = this.core.me?.hp ?? maxHp;
    const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;

    const iconSize = Math.round(headerH * 0.32);
    const barH = Math.max(10, Math.round(headerH * 0.11));
    const gap = 10;
    const valLbl = txt(`${this.core.fmtNum(hp)} / ${this.core.fmtNum(maxHp)}`, FS.body, C.mid);

    // The bar is sized off the header height, and in portrait the header is a THIRD of the design
    // width tall — 1.4x that came out at 478 of 1080 design px, which with the back pill's 443 left
    // the title a negative band to fit into (so it did not shrink at all and was drawn straight
    // through the readout). The cluster therefore also has a ceiling in bar-width terms: whatever
    // the bar's own height suggests, it may not eat more than a third of the bar.
    const MAX_SHARE = 0.34;
    const fixed = iconSize + gap + gap + valLbl.width;
    const barW = Math.max(
      Math.round(headerH * 0.5),
      Math.min(Math.round(headerH * 1.4), Math.round(this.core.w * MAX_SHARE) - fixed),
    );
    return {
      iconSize, barW, barH, gap, valLbl, hp, maxHp, ratio,
      clusterW: fixed + barW,
    };
  }

  renderHeaderDurability(headerH: number): void {
    const { w } = this.core;
    const { iconSize, barW, barH, gap, valLbl, ratio, clusterW } = this.durabilityMetrics(headerH);

    // Right-aligned cluster: [wall icon] [HP bar] [value]. Lay out right→left off the 16px inset.
    const x0 = w - 16 - clusterW;
    const midY = headerH / 2;

    const icon = this.core.bldIcon('wall', iconSize, C.dark);
    icon.x = x0;
    icon.y = midY - iconSize / 2;
    this.core.paint.pageLayer.addChild(icon);

    const barX = x0 + iconSize + gap;
    const barY = midY - barH / 2;
    const track = new PIXI.Graphics();
    track.beginFill(0x2a1e12, 0.15);
    track.drawRoundedRect(barX, barY, barW, barH, 3);
    track.endFill();
    this.core.paint.pageLayer.addChild(track);

    // Green (healthy) → amber (mid) → red (low) — mirrors the world-map tile HP bar
    // (worldmap/tileGraphics.ts drawHpBar) so the color language is consistent everywhere.
    const fillColor = ratio > 0.5 ? 0x3aa03a : ratio > 0.25 ? 0xd8a520 : 0xcc2222;
    const fill = new PIXI.Graphics();
    fill.beginFill(fillColor, 0.9);
    fill.drawRoundedRect(barX, barY, Math.max(2, barW * ratio), barH, 3);
    fill.endFill();
    this.core.paint.pageLayer.addChild(fill);

    valLbl.x = barX + barW + gap;
    valLbl.y = midY - valLbl.height / 2;
    this.core.paint.pageLayer.addChild(valLbl);
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
    this.core.paint.pageLayer.addChild(pg);

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
      this.core.paint.pageLayer.addChild(ab);

      const icon = chipped(33, RES_COLORS[rt], (n) => this.core.resIcon(rt, n));
      icon.x = cx + 12;
      icon.y = startY + 24;
      this.core.paint.pageLayer.addChild(icon);

      // Live total: grown client-side from the last fetch (tickResourceTotals updates it per second).
      const curLbl = txt(this.core.fmtNum(this.core.liveResource(rt)), FS.label, C.dark, true);
      curLbl.x = cx + 52;
      curLbl.y = startY + 24;
      this.core.paint.pageLayer.addChild(curLbl);
      this.core.resTotalLbls.push({ rt, lbl: curLbl });

      const capLbl = txt(`/${this.core.fmtNum(cap)}`, FS.small, C.mid);
      capLbl.x = cx + 12;
      capLbl.y = startY + 62;
      this.core.paint.pageLayer.addChild(capLbl);

      const yldLbl = txt(
        `+${this.core.fmtNum(rate)}/h`,
        FS.small,
        rate > 0 ? RES_COLORS[rt] : C.mid
      );
      yldLbl.x = cx + 12;
      yldLbl.y = startY + 84;
      this.core.paint.pageLayer.addChild(yldLbl);
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
    this.core.paint.pageLayer.addChild(pg);

    const hdr = txt(t('city.buildQueue'), FS.body, C.mid, true);
    hdr.x = cx0 + 24;
    hdr.y = startY + 14;
    this.core.paint.pageLayer.addChild(hdr);

    if (queue.length === 0) {
      const empty = txt(t('city.queueEmpty'), FS.body, C.mid);
      empty.x = cx0 + 195;
      empty.y = startY + 14;
      this.core.paint.pageLayer.addChild(empty);
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
      this.core.paint.pageLayer.addChild(entryLbl);

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
          () => void this.core.doSpeedup(entry.key),
          'hourglassSm'
        );
      }
    }

    return startY + panH + 4;
  }

  // ── Building grid ─────────────────────────────────────────────────────────

  // Split into ./buildingGrid.ts (form ①, same reason and same shape as ./teamRow.ts above) when
  // the portrait fill rule pushed this file past the 500-line convention.
  renderBuildingGrid(startY: number, bottomY: number): void {
    renderBuildingGridImpl(this.core, startY, bottomY);
  }
}
