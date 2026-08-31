// WorldMap territory panel — the Overview / List / World tab group opened from the header
// resource cluster, including the World tab's nation list and capital renaming.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../../render/sketchUi';
import { buildIcon } from '../../../render/icons';
import type { IconKind } from '../../../render/icons';
import { FS, snapFont } from '../../../render/fontScale';
import { drawHubTabs } from '../../../ui/widgets/HubTabs';
import { drawConfirmDialog } from '../../../ui/dialogs/confirmDialog';
import { getResTexture } from '../../../render/atlas/resAtlasLoader';
import { HUD_H, MARGIN } from '../logic/constants';
import {
  PANEL_W,
  PANEL_MARGIN,
  PANEL_PAD,
  PANEL_BTN_H,
  PANEL_CLOSE_W,
  PANEL_FOOTER_H,
  PANEL_TAB_H,
  PANEL_ROW_H,
  PANEL_ROW_BTN_W,
  PANEL_ROW_BTN_H,
  drawPanelTitle,
} from './spec';
import type { WorldMapPanelsCore } from './core';
import { renderWorldTabBody as renderWorldTabBodyImpl } from './territoryWorldTab';

export interface TerritoryHandlers {
  loadWorldTabData(): void;
  openTerritoryPanel(): void;
  renderTerritoryPanel(): void;
  openRenameInput(capitalIdx: number, current: string): void;
}

export class TerritoryPanel implements TerritoryHandlers {
  constructor(private readonly core: WorldMapPanelsCore) {}

  loadWorldTabData(): void {
    void this.core.ctx.cb.worldApi
      .getNations(this.core.ctx.cb.worldId)
      .then((n) => {
        this.core.ctx.nations = n;
      })
      .catch(() => {});
  }

  openTerritoryPanel(): void {
    if (!this.core.ctx.me?.joined) {
      this.core.showToast(t('world.needBase'), C.red);
      return;
    }
    this.core.ctx.territoryPanelOpen = true;
    this.core.ctx.territoryTab = 'overview';
    this.core.ctx.infoScrollY = 0;
    this.renderTerritoryPanel();
  }

  private switchTerritoryTab(tab: 'overview' | 'list' | 'world'): void {
    this.core.ctx.territoryTab = tab;
    this.core.ctx.infoScrollY = 0;
    this.renderTerritoryPanel();
    if (tab === 'list') {
      void this.core.ctx.net.refreshTerritories().then(() => {
        if (this.core.ctx.territoryPanelOpen && this.core.ctx.territoryTab === 'list')
          this.renderTerritoryPanel();
      });
    } else if (tab === 'world') {
      this.loadWorldTabData();
    }
  }

  renderTerritoryPanel(): void {
    const me = this.core.ctx.me;
    if (!me?.joined) {
      this.core.closeModal();
      return;
    }
    const ml = this.core.ctx.modalLayer;
    tearDownChildren(ml);
    this.core.ctx.modalBtnRects = [];

    const { w, h } = this.core.ctx;

    // Abandon confirm — the shared OK/Cancel dialog (ui/dialogs/confirmDialog), wired the same way
    // FamilyScene/SectScene wire it: it only draws and hands back hit rects, we keep owning the
    // modal layer / hit list / dim rect. It replaces the whole panel (drawn instead of it, not over
    // it) so the list's Jump/Abandon buttons underneath can't be clicked through the dialog — the
    // hand-rolled version this supersedes achieved that by returning early after painting itself
    // onto the panel body, but drew its own drifted 180x56 buttons and left the previous render's
    // `infoScrollRect` live, so a tap on OK/Cancel was still routed through the list's
    // drag-to-scroll gesture path. (2026-08-30 SLG widget pass.)
    if (this.core.ctx.territoryAbandonConfirm) {
      const { x: tx1, y: ty1 } = this.core.ctx.territoryAbandonConfirm;
      const msg = t('world.abandonConfirm').replace('{x}', String(tx1)).replace('{y}', String(ty1));
      this.core.ctx.infoScrollRect = null;
      this.core.ctx.infoScrollRerender = null;
      this.core.ctx.modalDimRect = { x: 0, y: 0, w, h };
      this.core.ctx.modalBtnRects = drawConfirmDialog(
        ml,
        w,
        h,
        msg,
        () => {
          this.core.ctx.territoryAbandonConfirm = null;
          void this.core.ctx.net.doAbandonFromList(tx1, ty1);
        },
        () => {
          this.core.ctx.territoryAbandonConfirm = null;
          this.renderTerritoryPanel();
        }
      );
      return;
    }

    // Width doubled (420→840, still clamped to the viewport) so the enlarged
    // overview text has room to breathe; 2026-08-30 it moved onto the shared width grid
    // (840→PANEL_W.lg), the widest tier since this is the one tabbed, data-dense panel.
    const pw = Math.min(PANEL_W.lg, w - PANEL_MARGIN * 2);
    // Panel height is 80% of the page height (capped so it never overlaps the HUD).
    const ph = Math.min(h * 0.8, h - HUD_H - 16);
    const px = (w - pw) / 2;
    const py = (h - HUD_H - ph) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.core.ctx.modalDimRect = { x: 0, y: 0, w, h };

    const panel = sketchPanel(pw, ph, { fill: C.paper, border: C.dark, seed: seedFor(11, 11, pw) });
    panel.x = px;
    panel.y = py;
    ml.addChild(panel);

    const addText = (
      s: string,
      tx2: number,
      ty: number,
      size = 12,
      color: number = C.dark
    ): void => {
      const lbl = txt(s, snapFont(size), color);
      lbl.x = tx2;
      lbl.y = ty;
      ml.addChild(lbl);
    };

    const tabY = drawPanelTitle(ml, t('world.territoryTitle'), px, py, pw);

    // Tabs
    const tabs: { id: 'overview' | 'list' | 'world'; label: string }[] = [
      { id: 'overview', label: t('world.territoryTabOverview') },
      { id: 'list', label: t('world.territoryTabList') },
      { id: 'world', label: t('world.info') },
    ];
    // The shared hub-tab strip (ui/widgets/HubTabs), not three hand-rolled solid `panelButton`
    // blocks: those drew the active tab as a red-filled slab and the inactive ones as dark slabs,
    // a tab language used nowhere else in the game. `drawHubTabs`'s `x`/`pad`/`gap` overrides let
    // the full-width strip sit inside this modal panel (2026-08-30 SLG widget pass).
    const tabHits = drawHubTabs(
      ml,
      pw,
      tabY,
      PANEL_TAB_H,
      tabs.map((tab) => ({ label: tab.label, active: this.core.ctx.territoryTab === tab.id })),
      (i) => this.switchTerritoryTab(tabs[i]!.id),
      { x: px, pad: PANEL_PAD, gap: MARGIN }
    );
    for (const hit of tabHits)
      this.core.ctx.modalBtnRects.push(hit);

    let ly = tabY + PANEL_TAB_H + PANEL_PAD;
    const bodyBottom = py + ph - PANEL_FOOTER_H;
    this.core.ctx.infoScrollRect = null;

    if (this.core.ctx.territoryTab === 'overview') {
      const res = me.resources ?? {};
      const yieldRate = me.yieldRate ?? {};
      const RES_LABEL: Record<string, string> = {
        ink: t('world.ink'),
        paper: t('world.paper'),
        graphite: t('world.graphite'),
        metal: t('world.metal'),
        sticker: t('world.sticker'),
      };

      // Resource table: icon | label | amount (right-aligned) | yield (right-aligned), with
      // a hairline under each row — reads as a table instead of five loose stacked lines.
      const tableX = px + PANEL_PAD;
      const tableRight = px + pw - PANEL_PAD;
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
          sp.x = tableX;
          sp.y = ly + 1;
          ml.addChild(sp);
        }
        addText(RES_LABEL[rt], tableX + iconSize + 8, ly, FS.label, C.dark);
        const amountLbl = txt(String(amt), FS.label, C.dark);
        amountLbl.anchor.set(1, 0);
        amountLbl.x = amountColX;
        amountLbl.y = ly;
        ml.addChild(amountLbl);
        const yieldLbl = txt(`+${yr}/${t('world.resYield')}`, FS.tiny, C.mid);
        yieldLbl.anchor.set(1, 0);
        yieldLbl.x = tableRight;
        yieldLbl.y = ly + 5;
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
      const cardW = (pw - PANEL_PAD * 2 - cardGap) / 2;
      const cardH = 60;
      const troops = Math.floor(me.troops ?? 0);
      const troopCap = Math.floor(me.troopCap ?? 0);
      const STAT_CARDS: { icon: IconKind; label: string; value: string }[] = [
        { icon: 'swords', label: t('world.troops'), value: `${troops}/${troopCap}` },
        { icon: 'castle', label: t('world.territory'), value: String(me.territoryCount ?? 0) },
      ];
      let cardX = px + PANEL_PAD;
      for (const card of STAT_CARDS) {
        const cardPanel = sketchPanel(cardW, cardH, {
          fill: C.paper,
          border: C.red,
          seed: seedFor(12, Math.round(cardX), cardW),
        });
        cardPanel.x = cardX;
        cardPanel.y = ly;
        ml.addChild(cardPanel);
        const cIcon = buildIcon(card.icon, 26, C.red);
        cIcon.x = cardX + 12;
        cIcon.y = ly + (cardH - 26) / 2;
        ml.addChild(cIcon);
        const cLbl = txt(card.label, FS.tiny, C.mid);
        cLbl.x = cardX + 46;
        cLbl.y = ly + 8;
        ml.addChild(cLbl);
        const cVal = txt(card.value, FS.heading, C.red, true);
        cVal.x = cardX + 46;
        cVal.y = ly + 24;
        ml.addChild(cVal);
        cardX += cardW + cardGap;
      }
      ly += cardH + 20;

      // Season summary — a single muted footer line, kept visually detached from the
      // resource table/stat cards above by extra spacing so it doesn't compete with them.
      const s = this.core.ctx.season;
      if (s) {
        const seasonLine = `${t('world.seasonNo').replace('{n}', String(s.season))}   ${t(
          'world.seasonPop'
        )
          .replace('{pop}', String(s.population))
          .replace('{cap}', String(s.capacity))}`;
        addText(seasonLine, px + PANEL_PAD, ly, FS.tiny, C.mid);
        ly += 24;
      }
    } else if (this.core.ctx.territoryTab === 'world') {
      this.renderWorldTabBody(px, pw, ly, bodyBottom);
    } else {
      // Level-filter checkbox grid, two rows — split evenly across the levels actually present.
      // Each chip is labeled with its tile count so the number behind a filter is visible without
      // toggling it on.
      const levelCounts = new Map<number, number>();
      for (const tv of this.core.ctx.territories)
        levelCounts.set(tv.level, (levelCounts.get(tv.level) ?? 0) + 1);
      const levels = Array.from(levelCounts.keys()).sort((a, b) => a - b);
      if (levels.length > 0) {
        // Capped at 5 chips per row so a handful of levels doesn't stretch each chip
        // across the whole panel width — wraps to more rows only once levels exceed 5.
        const perRow = Math.min(5, levels.length);
        const rows = Math.ceil(levels.length / perRow);
        const chkW = (pw - PANEL_PAD * 2 - MARGIN * (perRow - 1)) / perRow;
        for (let i = 0; i < levels.length; i++) {
          const lvl = levels[i]!;
          const row = Math.floor(i / perRow);
          const col = i % perRow;
          const hidden = this.core.ctx.territoryHiddenLevels.has(lvl);
          const cx3 = px + PANEL_PAD + col * (chkW + MARGIN);
          const cy3 = ly + row * (PANEL_ROW_BTN_H + MARGIN);
          this.core.panelButton(
            `Lv.${lvl} (${levelCounts.get(lvl)})`,
            cx3,
            cy3,
            chkW,
            PANEL_ROW_BTN_H,
            hidden ? C.mid : C.red,
            () => {
              if (hidden) this.core.ctx.territoryHiddenLevels.delete(lvl);
              else this.core.ctx.territoryHiddenLevels.add(lvl);
              this.renderTerritoryPanel();
            }
          );
        }
        ly += rows * (PANEL_ROW_BTN_H + MARGIN) + 8;
      }

      // Sorted by level then coords so the level chips above actually correspond to contiguous
      // runs in the list below (previously the raw fetch order interleaved levels, which read as
      // a rendering bug against the filter grouping).
      const filtered = this.core.ctx.territories
        .filter((tv) => !this.core.ctx.territoryHiddenLevels.has(tv.level))
        .sort((a, b) => a.level - b.level || a.x - b.x || a.y - b.y);
      if (filtered.length === 0) {
        addText(t('world.territoryEmpty'), px + PANEL_PAD, ly, FS.body, C.mid);
      } else {
        // Garrisons below half the fleet's median read as under-defended — flagged in red so a
        // thin tile stands out without needing a fixed absolute threshold.
        const sortedGarrisons = filtered.map((tv) => tv.garrison ?? 0).sort((a, b) => a - b);
        const medianGarrison = sortedGarrisons[Math.floor(sortedGarrisons.length / 2)] ?? 0;
        const weakThreshold = medianGarrison * 0.5;
        addText(t('world.weakGarrisonHint'), px + PANEL_PAD, ly, FS.small, C.mid);
        ly += 30;
        const rowH = PANEL_ROW_H;
        const listLayer = this.core.beginScrollList(
          px,
          ly,
          pw,
          bodyBottom - ly,
          filtered.length * rowH,
          () => this.renderTerritoryPanel(),
          rowH
        );
        let ry = ly - this.core.ctx.infoScrollY;
        for (const tv of filtered) {
          if (ry + rowH >= ly && ry <= bodyBottom) {
            const garrison = tv.garrison ?? 0;
            const label = `(${tv.x},${tv.y})  Lv.${tv.level}  ${t('world.garrison').replace(
              '{n}',
              String(garrison)
            )}`;
            const nameLbl = txt(label, FS.body, garrison < weakThreshold ? C.red : C.dark);
            nameLbl.x = px + PANEL_PAD;
            nameLbl.y = ry + (rowH - nameLbl.height) / 2;
            listLayer.addChild(nameLbl);
            const btnW = PANEL_ROW_BTN_W;
            const btnY = ry + (rowH - PANEL_ROW_BTN_H) / 2;
            this.core.panelButtonIn(
              listLayer,
              t('world.territoryJump'),
              px + pw - btnW * 2 - PANEL_PAD - MARGIN,
              btnY,
              btnW,
              PANEL_ROW_BTN_H,
              C.accent,
              () => {
                this.core.ctx.view.centerAt(tv.x, tv.y);
                this.core.ctx.view.renderMap();
                this.core.closeModal();
              }
            );
            this.core.panelButtonIn(
              listLayer,
              t('world.actAbandon'),
              px + pw - btnW - PANEL_PAD,
              btnY,
              btnW,
              PANEL_ROW_BTN_H,
              C.red,
              () => {
                this.core.ctx.territoryAbandonConfirm = { x: tv.x, y: tv.y };
                this.renderTerritoryPanel();
              }
            );
          }
          ry += rowH;
        }
      }
    }

    // Close
    this.core.panelButton(
      t('common.close'),
      px + (pw - PANEL_CLOSE_W) / 2,
      py + ph - PANEL_BTN_H - PANEL_PAD / 2,
      PANEL_CLOSE_W,
      PANEL_BTN_H,
      C.dark,
      () => this.core.closeModal()
    );
  }

  private renderWorldTabBody(px: number, pw: number, ly: number, bodyBottom: number): void {
    renderWorldTabBodyImpl(
      this.core,
      px,
      pw,
      ly,
      bodyBottom,
      () => this.renderTerritoryPanel(),
      (capitalIdx, current) => this.openRenameInput(capitalIdx, current)
    );
  }

  openRenameInput(capitalIdx: number, current: string): void {
    if (this.core.ctx.hiddenInput) {
      this.core.ctx.hiddenInput.remove();
      this.core.ctx.hiddenInput = null;
    }
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
        if (name && name !== current) void this.core.ctx.net.doRename(capitalIdx, name);
      }
    });
    inp.addEventListener('blur', () => {
      inp.remove();
      if (this.core.ctx.hiddenInput === inp) this.core.ctx.hiddenInput = null;
    });
    this.core.ctx.hiddenInput = inp;
  }
}
