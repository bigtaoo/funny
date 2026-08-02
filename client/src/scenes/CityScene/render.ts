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
import { teamSlotId, teamSlotName, TEAM_CAP, teamTroopCap, teamLeaderCard } from '../../game/meta/teamTroops';
import { buildIcon } from '../../render/icons';
import { cardInstanceArtUrl } from '../../render/cardArt';
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
  type Constructor, type CitySceneBaseCtor,
  RES_COLORS, GRID_BUILDING_KEYS, CARD_GAP, CARD_W_TARGET, CARD_H, GRID_PAD, MAX_GRID_COLS,
  TEAM_ROW_CARD_H, TEAM_ROW_LABEL_H, bldAccentColor,
} from './base';

export interface RenderHandlers {
  renderHeaderDurability(headerH: number): void;
  renderTeamsRow(): number;
  renderTeamCard(i: number, x: number, y: number, cardW: number, cardH: number, now: number): void;
  renderResourceBar(startY: number): number;
  renderBuildQueue(startY: number): number;
  renderBuildingGrid(startY: number, bottomY: number): void;
}

export function RenderMixin<TBase extends CitySceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    // ── Page tabs (D-CITY-11: 内政 / 军事 switch) ────────────────────────────────

    // D-CITY-8: main-base durability — a persistent, self-healing HP bar for the player's own
    // base, capped by the `wall` building's level (baseDurabilityMax). Reads `me.hp`/`me.maxHp`
    // (same field names/semantics as WorldMapView's tile HP bar); falls back to a full bar
    // derived from the current wall level when the server hasn't resolved a main-base anchor yet
    // (e.g. brand-new account mid-joinWorld race). Drawn into the header bar's free right side
    // (the military page it used to have its own panel on was merged away 2026-07-23).
    renderHeaderDurability(headerH: number): void {
      const { w } = this;
      const bld = this.me?.buildings;
      const maxHp = this.me?.maxHp ?? baseDurabilityMax(buildingLevel(bld, 'wall'));
      const hp = this.me?.hp ?? maxHp;
      const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;

      const iconSize = Math.round(headerH * 0.32);
      const barW = Math.round(headerH * 1.4);
      const barH = Math.max(10, Math.round(headerH * 0.11));
      const gap = 10;
      const valLbl = txt(`${this.fmtNum(hp)} / ${this.fmtNum(maxHp)}`, FS.body, C.mid);

      // Right-aligned cluster: [wall icon] [HP bar] [value]. Lay out right→left off the 16px inset.
      const clusterW = iconSize + gap + barW + gap + valLbl.width;
      const x0 = w - 16 - clusterW;
      const midY = headerH / 2;

      const icon = this.bldIcon('wall', iconSize, C.dark);
      icon.x = x0;
      icon.y = midY - iconSize / 2;
      this.container.addChild(icon);

      const barX = x0 + iconSize + gap;
      const barY = midY - barH / 2;
      const track = new PIXI.Graphics();
      track.beginFill(0x2a1e12, 0.15);
      track.drawRoundedRect(barX, barY, barW, barH, 3);
      track.endFill();
      this.container.addChild(track);

      // Green (healthy) → amber (mid) → red (low) — mirrors the world-map tile HP bar
      // (worldmap/tileGraphics.ts drawHpBar) so the color language is consistent everywhere.
      const fillColor = ratio > 0.5 ? 0x3aa03a : (ratio > 0.25 ? 0xd8a520 : 0xcc2222);
      const fill = new PIXI.Graphics();
      fill.beginFill(fillColor, 0.9);
      fill.drawRoundedRect(barX, barY, Math.max(2, barW * ratio), barH, 3);
      fill.endFill();
      this.container.addChild(fill);

      valLbl.x = barX + barW + gap;
      valLbl.y = midY - valLbl.height / 2;
      this.container.addChild(valLbl);
    }

    // The 5 team slots (D-CITY-10) as one compact row pinned to the bottom of the scene. Returns
    // the top y of the band (section label + card row) so the building grid above knows where to
    // stop. This row is fixed (not scrolled) — only the building grid above it scrolls.
    renderTeamsRow(): number {
      const { h } = this;
      const cx0 = this.contentX;
      const w = this.w - cx0;
      const cardH = TEAM_ROW_CARD_H;
      const bandTop = h - GRID_PAD - (TEAM_ROW_LABEL_H + cardH);

      const sectionLbl = txt(t('city.military.teams'), FS.body, C.mid, true);
      sectionLbl.x = cx0 + GRID_PAD + 4;
      sectionLbl.y = bandTop;
      this.container.addChild(sectionLbl);

      // "填满所有队伍" (2026-08-02): one tap drains the home troop pool into all 5 teams in slot
      // order instead of opening each team's formation editor to hit 分兵 individually. Sits flush
      // inside the section-label row (same height as sectionLbl's row), never spilling into the
      // card row below it.
      const fillBtnW = 200;
      const fillBtnH = TEAM_ROW_LABEL_H;
      this.addBtn(
        cx0 + w - GRID_PAD - fillBtnW, bandTop, fillBtnW, fillBtnH,
        t('city.military.fillAllTeams'), 0xffffff, C.accent, () => void this.doFillAllTeams(),
      );

      const rowY = bandTop + TEAM_ROW_LABEL_H;
      const availW = w - GRID_PAD * 2;
      const cellW = Math.floor((availW - (TEAM_CAP - 1) * CARD_GAP) / TEAM_CAP);
      const now = Date.now();
      for (let i = 0; i < TEAM_CAP; i++) {
        const cx = cx0 + GRID_PAD + i * (cellW + CARD_GAP);
        this.renderTeamCard(i, cx, rowY, cellW, cardH, now);
      }
      return bandTop;
    }

    renderTeamCard(i: number, x: number, y: number, cardW: number, cardH: number, now: number): void {
      const id = teamSlotId(i);
      const team = this.teams.find(tm => tm.id === id);
      const filled = !!team && team.army.length > 0;
      const injuredUntil = this.me?.teamState?.[id]?.injuredUntil ?? 0;
      const injured = injuredUntil > now;
      const order = this.teamOrder(id);
      const pad = 10;

      const border = injured ? C.red : (order ? C.gold : (filled ? C.accent : C.mid));
      const panel = sketchPanel(cardW, cardH, {
        fill: filled ? 0xfaf9f5 : C.paper, border, width: filled ? 2 : 1.2, seed: seedFor(x, y, cardW),
      });
      panel.x = x;
      panel.y = y;
      this.container.addChild(panel);

      // Leader portrait (2026-07-25): the team's own picture, so the five slots are told apart at a glance
      // instead of by reading "Team 1..5". Explicit 领队 pick from the formation editor, else the strongest
      // card — see teamLeaderCard(). Occupies the card's right edge; the text column shrinks to clear it.
      const save = this.cb.getSave?.();
      const leader = filled ? teamLeaderCard(team, save?.cardInv, save?.equipmentInv) : undefined;
      const artUrl = leader ? cardInstanceArtUrl(leader, save?.equipped) : null;
      let textW = cardW - pad * 2;
      if (artUrl) {
        const artSize = Math.min(cardH - pad * 2, 76);
        const ax = x + cardW - pad - artSize;
        const ay = y + (cardH - artSize) / 2;
        const frame = sketchPanel(artSize, artSize, {
          fill: 0xf0eee7, border: C.gold, width: 1.6, seed: seedFor(ax, ay, artSize),
        });
        frame.x = ax; frame.y = ay;
        this.container.addChild(frame);
        this.drawArtFit(artUrl, ax + 2, ay + 2, artSize - 4, artSize - 4);
        textW = Math.max(40, ax - 8 - (x + pad));
      }

      const name = txt(team?.name || teamSlotName(i), FS.body, C.dark, true, textW);
      name.x = x + pad;
      name.y = y + pad;
      this.container.addChild(name);

      let statusLbl: string;
      let statusColor: number;
      if (injured) {
        const secsLeft = Math.ceil((injuredUntil - now) / 1000);
        const timeStr = secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
        statusLbl = t('roster.injured').replace('{time}', timeStr);
        statusColor = C.red as number;
      } else if (order) {
        const remaining = Math.max(0, Math.ceil((('march' in order ? order.march.arriveAt : order.occ.dueAt) - now) / 1000));
        const timeStr = remaining >= 60 ? `${Math.ceil(remaining / 60)}m` : `${remaining}s`;
        statusLbl = 'march' in order
          ? t('world.team.marching')
          : t('world.team.occupying').replace('{time}', timeStr);
        statusColor = C.gold as number;
      } else if (filled) {
        statusLbl = t('city.military.teamIdle');
        statusColor = C.accent as number;
      } else {
        statusLbl = t('world.team.empty');
        statusColor = C.mid as number;
      }
      const statusTag = txt(statusLbl, FS.small, statusColor, true, textW);
      statusTag.x = x + pad;
      statusTag.y = y + pad + 26;
      this.container.addChild(statusTag);

      if (filled) {
        // Troops as carried/cap (2026-07-25): a bare number said nothing about how full the team is, and
        // the same carried/cap pair is what the formation editor's header shows. "Heroes N" replaces the old
        // "Garrison N" label — N counts cards, which read as a second troop figure sitting right beside the real one.
        const committed = this.committedTroops(team!.army);
        const cap = teamTroopCap(team!.army, save?.cardInv);
        const troopsStr = cap > 0 ? `${committed}/${cap}` : String(committed);
        const sub = `${t('world.team.cards').replace('{n}', String(team!.army.length))}   ${t('world.team.committed').replace('{n}', troopsStr)}`;
        const subLbl = txt(sub, FS.small, C.mid, false, textW);
        subLbl.x = x + pad;
        subLbl.y = y + cardH - pad - 34;
        this.container.addChild(subLbl);
      }

      // Tap-to-edit — the row is fixed (not scrolled), so the hit rect is already absolute screen
      // space. Editing itself lives in the team formation editor (onEditTeam callback).
      if (this.cb.onEditTeam) {
        const teamName = team?.name || teamSlotName(i);
        this.hits.push({ x, y, w: cardW, h: cardH, fn: () => this.cb.onEditTeam!(id, teamName) });
      }
    }

    // ── Resource bar ──────────────────────────────────────────────────────────

    renderResourceBar(startY: number): number {
      const cx0 = this.contentX;
      const w = this.w - cx0;
      const bld = this.me?.buildings;

      const panH = 108;
      const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.mid, width: 1, seed: seedFor(w, panH, 3) });
      pg.x = cx0 + 8;
      pg.y = startY;
      this.container.addChild(pg);

      const cellW = Math.floor((w - 16) / 5);
      RESOURCE_TYPES.forEach((rt, i) => {
        const cx = cx0 + 8 + i * cellW;
        const cap = resourceCapFor(bld);
        // Actual hourly production (server-computed: tile yield × building mult + self-yield + BP),
        // not the raw building multiplier — this is the "产量" the player cares about.
        const rate = Math.round(this.me?.yieldRate?.[rt] ?? 0);

        // Color accent bar
        const ab = new PIXI.Graphics();
        ab.beginFill(RES_COLORS[rt], 0.45);
        ab.drawRect(cx + 9, startY + 6, cellW - 18, 10);
        ab.endFill();
        this.container.addChild(ab);

        const icon = this.resIcon(rt, 33);
        icon.x = cx + 12;
        icon.y = startY + 24;
        this.container.addChild(icon);

        // Live total: grown client-side from the last fetch (tickResourceTotals updates it per second).
        const curLbl = txt(this.fmtNum(this.liveResource(rt)), FS.label, C.dark, true);
        curLbl.x = cx + 52;
        curLbl.y = startY + 24;
        this.container.addChild(curLbl);
        this.resTotalLbls.push({ rt, lbl: curLbl });

        const capLbl = txt(`/${this.fmtNum(cap)}`, FS.small, C.mid);
        capLbl.x = cx + 12;
        capLbl.y = startY + 62;
        this.container.addChild(capLbl);

        const yldLbl = txt(`+${this.fmtNum(rate)}/h`, FS.small, rate > 0 ? RES_COLORS[rt] : C.mid);
        yldLbl.x = cx + 12;
        yldLbl.y = startY + 84;
        this.container.addChild(yldLbl);
      });

      return startY + panH + 4;
    }

    // ── Build queue ───────────────────────────────────────────────────────────

    renderBuildQueue(startY: number): number {
      const cx0 = this.contentX;
      const w = this.w - cx0;
      const queue = this.me?.buildQueue ?? [];
      const now = serverNow();

      const panH = queue.length > 0 ? 72 : 51;
      const pg = sketchPanel(w - 16, panH, { fill: C.paper, border: C.mid, width: 1, seed: seedFor(w, panH, 5) });
      pg.x = cx0 + 8;
      pg.y = startY;
      this.container.addChild(pg);

      const hdr = txt(t('city.buildQueue'), FS.body, C.mid, true);
      hdr.x = cx0 + 24;
      hdr.y = startY + 14;
      this.container.addChild(hdr);

      if (queue.length === 0) {
        const empty = txt(t('city.queueEmpty'), FS.body, C.mid);
        empty.x = cx0 + 195;
        empty.y = startY + 14;
        this.container.addChild(empty);
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
        this.container.addChild(entryLbl);

        if (secsLeft > 0) {
          const coins = Math.ceil(secsLeft / BUILD_SPEEDUP_SECS_PER_COIN);
          const speedLabel = t('city.speedup').replace('{coins}', String(coins));
          this.addBtn(cx0 + w - 249, startY + 9, 228, 45, speedLabel, 0xffffff, C.gold, () => void this.doSpeedup(entry.key));
        }
      }

      return startY + panH + 4;
    }

    // ── Building grid ─────────────────────────────────────────────────────────

    /** @param bottomY hard lower bound for the grid's viewport — the top of the pinned team row. */
    renderBuildingGrid(startY: number, bottomY: number): void {
      const cx0 = this.contentX;
      const w = this.w - cx0;
      const bld = this.me?.buildings;
      // Grid tiles = every building (incl. academy/tech-tree) plus a synthetic "Train Troops" action
      // tile spliced in right after drillYard (sibling to it, not nested in its modal). Training feeds
      // the unified troop pool.
      const tiles: Array<{ kind: 'bld'; key: BuildingKey } | { kind: 'train' }> = [];
      for (const key of GRID_BUILDING_KEYS) {
        tiles.push({ kind: 'bld', key });
        if (key === 'drillYard') tiles.push({ kind: 'train' });
      }

      const availW = w - GRID_PAD * 2;
      const cols = Math.min(MAX_GRID_COLS, Math.max(1, Math.floor((availW + CARD_GAP) / (CARD_W_TARGET + CARD_GAP))));
      const cellW = Math.floor((availW - (cols - 1) * CARD_GAP) / cols);
      const rows = Math.ceil(tiles.length / cols);
      const contentH = rows * CARD_H + (rows - 1) * CARD_GAP;

      const viewY = startY;
      const availH = Math.max(0, bottomY - viewY);
      // Clamp so overflow always cuts mid-row, leaving a partial next card peeking above the fold.
      const viewH = peekViewportH(availH, CARD_H + CARD_GAP, contentH);
      this.scrollMax = Math.max(0, contentH - viewH);
      if (this.scrollY > this.scrollMax) this.scrollY = this.scrollMax;
      this.regionTop = viewY;
      this.regionBottom = viewY + viewH;

      const gridLayer = new PIXI.Container();
      gridLayer.x = cx0;
      gridLayer.y = viewY - this.scrollY;
      const maskG = new PIXI.Graphics();
      maskG.beginFill(0xffffff).drawRect(cx0, viewY, w, viewH).endFill();
      this.container.addChild(maskG);
      gridLayer.mask = maskG;
      this.container.addChild(gridLayer);

      tiles.forEach((tile, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = GRID_PAD + col * (cellW + CARD_GAP);
        // Local to gridLayer (which is itself offset by viewY - scrollY), so this is NOT absolute screen space.
        const cy = row * (CARD_H + CARD_GAP);

        // "Active" ring: a queued build for buildings, or an in-progress training batch for the train tile.
        const active = tile.kind === 'bld'
          ? (this.me?.buildQueue ?? []).some(q => q.key === tile.key)
          : (this.me?.trainingQueue?.length ?? 0) > 0;
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
        const ratio = tile.kind === 'bld'
          ? Math.max(0, Math.min(1, buildingLevel(bld, tile.key) / (tile.key === 'desk' ? DESK_MAX_LEVEL : Math.max(1, buildingLevel(bld, 'desk')))))
          : (troopCapFor(bld) > 0 ? Math.max(0, Math.min(1, (this.me?.troops ?? 0) / troopCapFor(bld))) : 0);
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

        const icon = tile.kind === 'bld' ? this.bldIcon(tile.key, 60, C.dark) : buildIcon('armor', 60, C.dark);
        icon.x = cx + (cellW - 60) / 2;
        icon.y = cy + 18;
        icon.alpha = dim ? 0.4 : 1;
        gridLayer.addChild(icon);

        const name = tile.kind === 'bld' ? t(`city.bld.${tile.key}` as 'city.bld.desk') : t('city.bld.trainTroops');
        const nameLbl = txt(name, FS.body, C.dark, true, cellW - 18);
        nameLbl.x = cx + 9;
        nameLbl.y = cy + 90;
        nameLbl.alpha = dim ? 0.55 : 1;
        gridLayer.addChild(nameLbl);

        // Buildings show a level; the train tile shows the current troop pool / cap instead.
        const subtitle = tile.kind === 'bld'
          ? t('city.lvlLabel').replace('{lvl}', String(buildingLevel(bld, tile.key)))
          : t('city.troopCap').replace('{cur}', String(this.me?.troops ?? 0)).replace('{cap}', String(troopCapFor(bld)));
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
        const screenY = viewY - this.scrollY + cy;
        if (screenY + CARD_H > viewY && screenY < viewY + viewH) {
          this.hits.push({
            x: cx0 + cx, y: screenY, w: cellW, h: CARD_H,
            fn: tile.kind === 'bld'
              ? () => { this.selectedBuilding = tile.key; this.render(); }
              : () => { this.selectedTrain = true; this.render(); },
          });
        }
      });

      drawScrollIndicator(this.container, { x: cx0, y: viewY, w, h: viewH }, this.scrollY, this.scrollMax);
    }
  };
}
