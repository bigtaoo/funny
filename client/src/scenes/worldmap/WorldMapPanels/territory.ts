// WorldMap territory panel — the Overview / List / World tab group opened from the header
// resource cluster, including the World tab's nation list and capital renaming.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import type { IconKind } from '../../../render/icons';
import { FS, snapFont } from '../../../render/fontScale';
import { serverNow } from '../../../net/serverClock';
import { getResTexture } from '../../../render/atlas/resAtlasLoader';
import { HUD_H, MARGIN } from '../constants';
import type { Constructor, WorldMapPanelsBaseCtor } from './base';

export interface TerritoryHandlers {
  loadWorldTabData(): void;
  openTerritoryPanel(): void;
  renderTerritoryPanel(): void;
  openRenameInput(capitalIdx: number, current: string): void;
}

export function TerritoryMixin<TBase extends WorldMapPanelsBaseCtor>(Base: TBase): TBase & Constructor<TerritoryHandlers> {
  return class extends Base {
    loadWorldTabData(): void {
      void this.ctx.cb.worldApi.getNations(this.ctx.cb.worldId)
        .then((n) => { this.ctx.nations = n; })
        .catch(() => {});
    }

    openTerritoryPanel(): void {
      if (!this.ctx.me?.joined) { this.showToast(t('world.needBase'), C.red); return; }
      this.ctx.territoryPanelOpen = true;
      this.ctx.territoryTab = 'overview';
      this.ctx.infoScrollY = 0;
      this.renderTerritoryPanel();
    }

    private switchTerritoryTab(tab: 'overview' | 'list' | 'world'): void {
      this.ctx.territoryTab = tab;
      this.ctx.infoScrollY = 0;
      this.renderTerritoryPanel();
      if (tab === 'list') {
        void this.ctx.net.refreshTerritories().then(() => {
          if (this.ctx.territoryPanelOpen && this.ctx.territoryTab === 'list') this.renderTerritoryPanel();
        });
      } else if (tab === 'world') {
        this.loadWorldTabData();
      }
    }

    renderTerritoryPanel(): void {
      const me = this.ctx.me;
      if (!me?.joined) { this.closeModal(); return; }
      const ml = this.ctx.modalLayer;
      tearDownChildren(ml);
      this.ctx.modalBtnRects = [];

      const { w, h } = this.ctx;
      // Width doubled (420→840, still clamped to the viewport) so the enlarged
      // overview text has room to breathe.
      const pw = Math.min(840, w - 20);
      // Panel height is 80% of the page height (capped so it never overlaps the HUD).
      const ph = Math.min(h * 0.8, h - HUD_H - 16);
      const px = (w - pw) / 2;
      const py = (h - HUD_H - ph) / 2;

      const dim = new PIXI.Graphics();
      dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
      ml.addChild(dim);
      this.ctx.modalDimRect = { x: 0, y: 0, w, h };

      const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(11, 11, pw) });
      panel.x = px; panel.y = py;
      ml.addChild(panel);

      // Abandon confirm — replaces the whole panel body so the underlying list buttons can't be
      // clicked through the dialog (this branch draws nothing else and returns early).
      if (this.ctx.territoryAbandonConfirm) {
        const { x: tx1, y: ty1 } = this.ctx.territoryAbandonConfirm;
        const msg = t('world.abandonConfirm').replace('{x}', String(tx1)).replace('{y}', String(ty1));
        const mLbl = txt(msg, FS.label, C.dark);
        mLbl.anchor.set(0.5, 0); mLbl.x = px + pw / 2; mLbl.y = py + ph / 2 - 50;
        mLbl.style.wordWrap = true; mLbl.style.wordWrapWidth = pw - 60; mLbl.style.align = 'center';
        ml.addChild(mLbl);
        const btnW = 120, btnH = 42;
        this.panelButton(t('common.ok'), px + pw / 2 - btnW - 10, py + ph / 2 + 10, btnW, btnH, C.red, () => {
          this.ctx.territoryAbandonConfirm = null;
          void this.ctx.net.doAbandonFromList(tx1, ty1);
        });
        this.panelButton(t('common.cancel'), px + pw / 2 + 10, py + ph / 2 + 10, btnW, btnH, C.dark, () => {
          this.ctx.territoryAbandonConfirm = null;
          this.renderTerritoryPanel();
        });
        return;
      }

      const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark): void => {
        const lbl = txt(s, snapFont(size), color);
        lbl.x = tx2; lbl.y = ty;
        ml.addChild(lbl);
      };

      const title = txt(t('world.territoryTitle'), FS.tiny, C.accent);
      title.anchor.set(0.5, 0); title.x = px + pw / 2; title.y = py + 10;
      ml.addChild(title);

      // Tabs
      const tabs: { id: 'overview' | 'list' | 'world'; label: string }[] = [
        { id: 'overview', label: t('world.territoryTabOverview') },
        { id: 'list', label: t('world.territoryTabList') },
        { id: 'world', label: t('world.info') },
      ];
      const tabW = (pw - 28 - MARGIN * 2) / 3;
      let tabX = px + 14;
      const tabY = py + 34;
      for (const tab of tabs) {
        const active = this.ctx.territoryTab === tab.id;
        this.panelButton(tab.label, tabX, tabY, tabW, 26, active ? C.red : C.dark, () => this.switchTerritoryTab(tab.id));
        tabX += tabW + MARGIN;
      }

      let ly = tabY + 38;
      const bodyBottom = py + ph - 42;
      this.ctx.infoScrollRect = null;

      if (this.ctx.territoryTab === 'overview') {
        const res = me.resources ?? {};
        const yieldRate = me.yieldRate ?? {};
        const RES_LABEL: Record<string, string> = { ink: t('world.ink'), paper: t('world.paper'), graphite: t('world.graphite'), metal: t('world.metal'), sticker: t('world.sticker') };

        // Resource table: icon | label | amount (right-aligned) | yield (right-aligned), with
        // a hairline under each row — reads as a table instead of five loose stacked lines.
        const tableX = px + 14;
        const tableRight = px + pw - 14;
        const iconSize = 26;
        const amountColX = px + pw * 0.62;
        const rowH = 40;
        const hairlines = new PIXI.Graphics();
        hairlines.lineStyle(1, C.light, 1);
        for (const rt of ['ink', 'paper', 'graphite', 'metal', 'sticker']) {
          const amt = Math.floor(res[rt] ?? 0);
          const yr = Math.round(yieldRate[rt] ?? 0);
          const tex = getResTexture(rt);
          if (tex) {
            const sp = new PIXI.Sprite(tex);
            sp.width = sp.height = iconSize;
            sp.x = tableX; sp.y = ly + 1;
            ml.addChild(sp);
          }
          addText(RES_LABEL[rt], tableX + iconSize + 8, ly, FS.label, C.dark);
          const amountLbl = txt(String(amt), FS.label, C.dark);
          amountLbl.anchor.set(1, 0); amountLbl.x = amountColX; amountLbl.y = ly;
          ml.addChild(amountLbl);
          const yieldLbl = txt(`+${yr}/${t('world.resYield')}`, FS.tiny, C.mid);
          yieldLbl.anchor.set(1, 0); yieldLbl.x = tableRight; yieldLbl.y = ly + 5;
          ml.addChild(yieldLbl);
          hairlines.moveTo(tableX, ly + rowH - 8).lineTo(tableRight, ly + rowH - 8);
          ly += rowH;
        }
        ml.addChild(hairlines);
        ly += 16;

        // Troops / territory as a pair of stat cards (icon + label + value) instead of two
        // bare red text lines — gives the two "headline" numbers visual weight of their own
        // rather than just being bigger text in the same stack.
        const cardGap = MARGIN;
        const cardW = (pw - 28 - cardGap) / 2;
        const cardH = 60;
        const troops = Math.floor(me.troops ?? 0);
        const troopCap = Math.floor(me.troopCap ?? 0);
        const STAT_CARDS: { icon: IconKind; label: string; value: string }[] = [
          { icon: 'swords', label: t('world.troops'), value: `${troops}/${troopCap}` },
          { icon: 'castle', label: t('world.territory'), value: String(me.territoryCount ?? 0) },
        ];
        let cardX = px + 14;
        for (const card of STAT_CARDS) {
          const cardPanel = sketchPanel(cardW, cardH, { fill: C.paper, border: C.red, seed: seedFor(12, Math.round(cardX), cardW) });
          cardPanel.x = cardX; cardPanel.y = ly;
          ml.addChild(cardPanel);
          const cIcon = buildIcon(card.icon, 26, C.red);
          cIcon.x = cardX + 12; cIcon.y = ly + (cardH - 26) / 2;
          ml.addChild(cIcon);
          const cLbl = txt(card.label, FS.tiny, C.mid);
          cLbl.x = cardX + 46; cLbl.y = ly + 8;
          ml.addChild(cLbl);
          const cVal = txt(card.value, FS.heading, C.red, true);
          cVal.x = cardX + 46; cVal.y = ly + 24;
          ml.addChild(cVal);
          cardX += cardW + cardGap;
        }
        ly += cardH + 20;

        // Season summary — a single muted footer line, kept visually detached from the
        // resource table/stat cards above by extra spacing so it doesn't compete with them.
        const s = this.ctx.season;
        if (s) {
          const seasonLine = `${t('world.seasonNo').replace('{n}', String(s.season))}   ${t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity))}`;
          addText(seasonLine, px + 14, ly, FS.tiny, C.mid);
          ly += 24;
        }
      } else if (this.ctx.territoryTab === 'world') {
        this.renderWorldTabBody(px, pw, ly, bodyBottom);
      } else {
        // Level-filter checkbox grid, two rows — split evenly across the levels actually present.
        // Each chip is labeled with its tile count so the number behind a filter is visible without
        // toggling it on.
        const levelCounts = new Map<number, number>();
        for (const tv of this.ctx.territories) levelCounts.set(tv.level, (levelCounts.get(tv.level) ?? 0) + 1);
        const levels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
        if (levels.length > 0) {
          // Capped at 5 chips per row so a handful of levels doesn't stretch each chip
          // across the whole panel width — wraps to more rows only once levels exceed 5.
          const perRow = Math.min(5, levels.length);
          const rows = Math.ceil(levels.length / perRow);
          const chkW = (pw - 28 - MARGIN * (perRow - 1)) / perRow;
          for (let i = 0; i < levels.length; i++) {
            const lvl = levels[i]!;
            const row = Math.floor(i / perRow);
            const col = i % perRow;
            const hidden = this.ctx.territoryHiddenLevels.has(lvl);
            const cx3 = px + 14 + col * (chkW + MARGIN);
            const cy3 = ly + row * 28;
            this.panelButton(`Lv.${lvl} (${levelCounts.get(lvl)})`, cx3, cy3, chkW, 24, hidden ? C.mid : C.red, () => {
              if (hidden) this.ctx.territoryHiddenLevels.delete(lvl); else this.ctx.territoryHiddenLevels.add(lvl);
              this.renderTerritoryPanel();
            }, 10);
          }
          ly += rows * 28 + 8;
        }

        // Sorted by level then coords so the level chips above actually correspond to contiguous
        // runs in the list below (previously the raw fetch order interleaved levels, which read as
        // a rendering bug against the filter grouping).
        const filtered = this.ctx.territories
          .filter((tv) => !this.ctx.territoryHiddenLevels.has(tv.level))
          .sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
        if (filtered.length === 0) {
          addText(t('world.territoryEmpty'), px + 14, ly, 11, C.mid);
        } else {
          // Garrisons below half the fleet's median read as under-defended — flagged in red so a
          // thin tile stands out without needing a fixed absolute threshold.
          const sortedGarrisons = filtered.map((tv) => tv.garrison ?? 0).sort((a, b) => a - b);
          const medianGarrison = sortedGarrisons[Math.floor(sortedGarrisons.length / 2)] ?? 0;
          const weakThreshold = medianGarrison * 0.5;
          addText(t('world.weakGarrisonHint'), px + 14, ly, FS.tiny, C.mid);
          ly += 20;
          const rowH = 34;
          const listLayer = this.beginScrollList(px, ly, pw, bodyBottom - ly, filtered.length * rowH, () => this.renderTerritoryPanel());
          let ry = ly - this.ctx.infoScrollY;
          for (const tv of filtered) {
            if (ry + rowH >= ly && ry <= bodyBottom) {
              const garrison = tv.garrison ?? 0;
              const label = `(${tv.x},${tv.y})  Lv.${tv.level}  ${t('world.garrison').replace('{n}', String(garrison))}`;
              const nameLbl = txt(label, FS.micro, garrison < weakThreshold ? C.red : C.dark);
              nameLbl.x = px + 14; nameLbl.y = ry + 8;
              listLayer.addChild(nameLbl);
              const btnW = 56;
              this.panelButtonIn(listLayer, t('world.territoryJump'), px + pw - btnW * 2 - 22, ry + 2, btnW, 26,
                C.accent, () => { this.ctx.view.centerAt(tv.x, tv.y); this.ctx.view.renderMap(); this.closeModal(); });
              this.panelButtonIn(listLayer, t('world.actAbandon'), px + pw - btnW - 14, ry + 2, btnW, 26,
                C.red, () => { this.ctx.territoryAbandonConfirm = { x: tv.x, y: tv.y }; this.renderTerritoryPanel(); });
            }
            ry += rowH;
          }
        }
      }

      // Close
      this.panelButton(t('world.close'), px + pw / 2 - 50, py + ph - 34, 100, 28, C.dark, () => this.closeModal());
    }

    private renderWorldTabBody(px: number, pw: number, ly: number, bodyBottom: number): void {
      const ml = this.ctx.modalLayer;
      const addText = (s: string, tx2: number, ty: number, size = 12, color: number = C.dark, anchorX = 0): void => {
        const lbl = txt(s, snapFont(size), color);
        lbl.anchor.set(anchorX, 0);
        lbl.x = tx2; lbl.y = ty;
        ml.addChild(lbl);
      };

      let cy = ly;
      this.ctx.infoScrollRect = null;

      // Season summary — short and static, so it stays pinned above the scrollable nations list
      // instead of eating into the scroll region.
      addText(t('world.tabSeason'), px + 14, cy, FS.tiny, C.accent); cy += 22;
      const s = this.ctx.season;
      if (!s) {
        addText('—', px + 14, cy, 11, C.mid); cy += 18;
      } else {
        addText(t('world.seasonNo').replace('{n}', String(s.season)), px + 14, cy, 13, C.red); cy += 22;
        const statusKey = `world.season.${s.status}`;
        addText(t(statusKey as Parameters<typeof t>[0]), px + 14, cy, 11); cy += 18;
        addText(t('world.seasonPop').replace('{pop}', String(s.population)).replace('{cap}', String(s.capacity)), px + 14, cy, 11); cy += 18;
        if (s.resetAt) {
          const days = Math.max(0, Math.ceil((s.resetAt - serverNow()) / 86400000));
          addText(t('world.seasonReset').replace('{d}', String(days)), px + 14, cy, 11); cy += 18;
        }
      }
      cy += 14;

      addText(t('world.tabNations'), px + 14, cy, FS.tiny, C.accent); cy += 22;

      if (this.ctx.nations.length === 0) {
        addText(t('world.nationsEmpty'), px + 14, cy, 11, C.mid);
      } else {
        const rowH = 24;
        const listLayer = this.beginScrollList(px, cy, pw, bodyBottom - cy, this.ctx.nations.length * rowH, () => this.renderTerritoryPanel());
        let ry = cy - this.ctx.infoScrollY;
        for (const n of this.ctx.nations) {
          if (ry + rowH >= cy && ry <= bodyBottom) {
            const name = n.nationName || t('world.nationCol').replace('{idx}', String(n.capitalIdx));
            const mine = !!n.ownerId && n.ownerId === this.ctx.cb.accountId;
            const nStar = buildIcon('star', 12, C.gold);
            nStar.x = px + 14; nStar.y = ry - 1;
            listLayer.addChild(nStar);
            const nameLbl = txt(`${name}  (${n.x},${n.y})`, FS.micro, C.dark);
            nameLbl.x = px + 30; nameLbl.y = ry;
            listLayer.addChild(nameLbl);
            if (mine) {
              // Owner may rename their capital (server re-checks ownerId).
              const bw = 54;
              this.panelButtonIn(listLayer, t('world.nationRename'), px + pw - bw - 14, ry - 4, bw, 22, C.accent, () => this.openRenameInput(n.capitalIdx, name));
            } else {
              const status = n.ownerId ? t('world.nationOwned') : t('world.nationFree');
              const statusLbl = txt(status, FS.micro, n.ownerId ? C.red : C.mid);
              statusLbl.anchor.set(1, 0); statusLbl.x = px + pw - 14; statusLbl.y = ry;
              listLayer.addChild(statusLbl);
            }
          }
          ry += rowH;
        }
      }
    }

    openRenameInput(capitalIdx: number, current: string): void {
      if (this.ctx.hiddenInput) { this.ctx.hiddenInput.remove(); this.ctx.hiddenInput = null; }
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.value = current;
      inp.maxLength = 24;
      inp.placeholder = t('world.nationNamePrompt');
      inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(inp);
      inp.focus();
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const name = inp.value.trim();
          inp.remove();
          if (name && name !== current) void this.ctx.net.doRename(capitalIdx, name);
        }
      });
      inp.addEventListener('blur', () => {
        inp.remove();
        if (this.ctx.hiddenInput === inp) this.ctx.hiddenInput = null;
      });
      this.ctx.hiddenInput = inp;
    }
  };
}
