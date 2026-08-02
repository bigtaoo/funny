// Roster list view: the [Cards|Equipment] sidebar rail, the header currency/capacity readout, the
// scrolling icon-card grid, and the per-card cell renderer.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, marginLineX, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl } from '../../render/cardArt';
import { drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, CARD_INV_CAP, CARD_INV_OVERFLOW_BUFFER, troopCap, cardPower, cardAttack, cardHp } from '../../game/meta/cardDefs';
import {
  type Constructor, type CardSceneBaseCtor,
  CARD_CELL_H, CARD_CELL_W_TARGET, sortCards, injuryCountdown,
} from './base';

// Roster grid packs a fixed 5 cards per row (was auto-fit ~6) with roomier gaps than the shared CELL_GAP.
const ROSTER_COLS = 5;
const ROSTER_GAP = 24;

export interface ListHandlers {
  renderSidebar(): void;
  renderHeaderCurrency(): void;
  renderList(): void;
  renderCardCell(card: CardInstance, x: number, y: number, cellW: number, state: CardSLGState | undefined, now: number, save: SaveData): void;
}

export function ListMixin<TBase extends CardSceneBaseCtor>(Base: TBase): TBase & Constructor<ListHandlers> {
  return class extends Base {
    /**
     * Per-card cell container + on-screen rect from the last renderList layout pass — lets
     * applyCardState()/refreshCardCell() redraw a single cell in place (SLG border/troop/team-tag
     * only) instead of a full relayout when cb.getCardState() data changes after the roster is
     * already open. Repopulated on every renderList pass; a card's cell position/size never
     * depends on SLG state, so there's no need to invalidate these across a state-only refresh.
     *
     * Declared with NO initializer (see EquipmentScene InventoryMixin's identical comment on
     * cellContainers/cellRects): the base class constructor calls render() — which populates these
     * via renderList() — before this mixin's own field initializers would run, and a `= new Map()`
     * here would clobber that first population with an empty map right after `super()`.
     */
    private cellContainers!: Map<string, PIXI.Container>;
    private cellRects!: Map<string, { x: number; y: number; w: number }>;

    /**
     * Redraw one roster cell in place (its SLG-derived border/troop-count/deployed-tag) — see
     * applyCardState(). Returns false (caller has nothing to fall back to; the cell just stays as
     * last rendered) when the cell isn't currently tracked, e.g. scrolled out of view since the
     * last full render.
     */
    private refreshCardCell(cardId: string): boolean {
      const container = this.cellContainers.get(cardId);
      const rect = this.cellRects.get(cardId);
      if (!container || container.destroyed || !rect) return false;
      const save = this.cb.getSave();
      const card = save.cardInv?.[cardId];
      if (!card) return false;

      tearDownChildren(container);
      this.hitRects = this.hitRects.filter((h) => h.owner !== cardId);
      const state = this.cb.getCardState?.()?.[cardId];
      const outerLayer = this.bodyLayer;
      this.bodyLayer = container;
      this.renderCardCell(card, rect.x, rect.y, rect.w, state, Date.now(), save);
      this.bodyLayer = outerLayer;
      return true;
    }

    /**
     * Patch the SLG-derived parts of every currently-tracked roster cell (+ the detail modal, if
     * open) in place after cb.getCardState()/getTeamName() data changes — e.g. game.ts'
     * goCardRoster's worldsvc fetch resolving after the roster already gave up and opened without
     * it. Deliberately not a full render(): the grid's layout (card order/position/size) never
     * depends on SLG state, so rebuilding the sidebar/header/scroll position would just be wasted
     * work (and would reset scroll position — a visible regression a full re-render would cause).
     */
    applyCardState(): void {
      if (this.tab !== 'list') return;
      for (const cardId of this.cellContainers.keys()) this.refreshCardCell(cardId);
      if (this.detailId) this.openDetail(this.detailId);
    }

    /**
     * Progression group nav [Cards|Equipment?|Skins] (LOBBY_IA_REDESIGN §15). Landscape draws a
     * vertical rail stacked inside the left notebook-margin gutter (`marginLineX`), below the
     * header; portrait draws it as a bottom nav bar instead (§18). Equipment only appears when
     * injected (openEquipmentBag, server-authoritative → online-only); Cards/Skins are always
     * reachable (including offline, reading the local save mirror).
     */
    renderSidebar(): void {
      const { w, h, landscape } = this;
      const hasEquip = !!this.cb.openEquipmentBag;
      const tabs: HubTab[] = [
        { label: t('roster.title'), active: this.tab === 'list', icon: 'cards' },
        ...(hasEquip ? [{ label: t('equip.title'), active: false, icon: 'armor' as const }] : []),
        { label: t('roster.tab.skins'), active: this.tab === 'skins', icon: 'brush' },
      ];
      const onSelect = (i: number): void => {
        if (i === 0) { this.tab = 'list'; this.render(); return; }
        if (hasEquip && i === 1) { this.cb.openEquipmentBag?.(); return; }
        this.tab = 'skins'; this.render();
      };
      if (!landscape) {
        const barH = bottomNavH(h);
        const { hits } = drawBottomNavTabs(this.bodyLayer, w, h - barH, barH, tabs, onSelect);
        for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
        return;
      }
      const sidebarW = sidebarNavW(w, h, true);
      const { hits } = drawSidebarTabs(this.bodyLayer, sidebarW, this.headerH, h, tabs, onSelect);
      for (const hit of hits) this.hitRects.push({ rect: hit.rect, action: hit.fn });
    }

    /**
     * Coin balance + card-capacity readout drawn into the header row itself (same treatment as
     * EquipmentScene's renderHeaderCurrency), so the currency HUD stays visible and aligned with
     * the title when navigating between the card-inventory/equipment peer scenes instead of popping in/out.
     */
    renderHeaderCurrency(): void {
      tearDownChildren(this.headerOverlayLayer);
      const save = this.cb.getSave();
      const count = Object.keys(save.cardInv ?? {}).length;
      const warn = count >= CARD_INV_CAP - CARD_INV_OVERFLOW_BUFFER;
      const full = count >= CARD_INV_CAP;
      // Keep the coin + capacity readout at a compact absolute size (matches EquipmentScene, its
      // [Cards|Equipment] peer) rather than scaling it up with the taller unified header.
      drawHeaderCurrency(this.headerOverlayLayer, this.w, this.headerH, save.wallet.coins, [], {
        text: `${t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP))}`,
        color: full ? C.red : warn ? C.gold : C.mid,
      }, 100 / this.headerH);
    }

    renderList(): void {
      const { w, h } = this;
      const save = this.cb.getSave();
      const cardState = this.cb.getCardState?.() ?? {};
      const cards = Object.values(save.cardInv ?? {});
      const listY = this.headerH;
      // Portrait's sidebar nav is a bottom bar instead (§18) — reserve bottomNavH off the height
      // (the sidebar always shows, so this always applies in portrait) instead of width.
      const availH = h - listY - 8 - (this.landscape ? 0 : bottomNavH(h));

      if (cards.length === 0) {
        const lbl = txt(t('roster.empty'), FS.heading, C.mid);
        lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + availH / 2;
        lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
        this.bodyLayer.addChild(lbl);
        this.maxScroll = 0;
        this.cellContainers = new Map();
        this.cellRects = new Map();
        return;
      }

      const sorted = sortCards(cards, save.equipmentInv ?? {}, cardState);
      // Start the grid right of the sidebar rail (landscape, when shown) or the red margin rule
      // (portrait — the bottom nav bar reserves no width); right pad stays one ROSTER_GAP.
      const left = (this.landscape && this.showSidebar ? sidebarNavW(w, h, true) : marginLineX(w)) + ROSTER_GAP;
      const avail = w - left - ROSTER_GAP;
      // Fixed 5-per-row roster (was auto-fit ~6): wider cards, roomier gaps. Clamp down on narrow viewports.
      const cols = Math.max(1, Math.min(ROSTER_COLS, Math.floor((avail + ROSTER_GAP) / (CARD_CELL_W_TARGET + ROSTER_GAP))));
      const cellW = (avail - ROSTER_GAP * (cols - 1)) / cols;
      const rows = Math.ceil(sorted.length / cols);
      const totalH = rows * (CARD_CELL_H + ROSTER_GAP) + ROSTER_GAP;
      // No PIXI mask backs this grid (draw-cull only, see renderCardCell) — a row is either drawn in
      // full or skipped entirely, never cropped. peekViewportH's mid-row shrink is for *masked* grids
      // where it produces a genuine partial-row crop; applied here it just excludes a row that would
      // otherwise render in full within the naive viewport, leaving a dead gap at the bottom that
      // pops the row in only once scrolling pushes it past the shrunk cutoff (2026-07-23 roster bug).
      // Also the wheel-scroll viewport bounds, see wheelScroll.ts.
      const maxScroll = Math.max(0, totalH - availH);
      this.scrollY = Math.max(0, Math.min(this.scrollY, maxScroll));
      this.scrollRegionTop = listY;
      this.scrollRegionBottom = listY + availH;
      this.maxScroll = maxScroll;

      const now = Date.now();
      this.cellContainers = new Map();
      this.cellRects = new Map();
      const outerLayer = this.bodyLayer;
      sorted.forEach((card, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const x = left + col * (cellW + ROSTER_GAP);
        const y = listY + ROSTER_GAP + row * (CARD_CELL_H + ROSTER_GAP) - this.scrollY;
        if (y + CARD_CELL_H >= listY && y <= listY + availH) {
          // Each cell renders into its own container (child of the same outer bodyLayer) so a later
          // applyCardState() can tear down and redraw just this one cell — see refreshCardCell().
          const cellC = new PIXI.Container();
          outerLayer.addChild(cellC);
          this.cellContainers.set(card.id, cellC);
          this.cellRects.set(card.id, { x, y, w: cellW });
          this.bodyLayer = cellC;
          this.renderCardCell(card, x, y, cellW, cardState[card.id], now, save);
          this.bodyLayer = outerLayer;
        }
      });

      drawScrollIndicator(this.bodyLayer, { x: left, y: listY, w: avail, h: availH }, this.scrollY, Math.max(0, totalH - availH));
    }

    /**
     * Icon-card cell: a full-height unit portrait on the left, with every hero detail
     * (name / level / power / troops / status / gear) stacked in a column immediately to
     * its right. Border color encodes SLG state (injured = red, deployed = accent).
     */
    renderCardCell(
      card: CardInstance,
      x: number,
      y: number,
      cellW: number,
      state: CardSLGState | undefined,
      now: number,
      save: SaveData,
    ): void {
      const def = CARD_DEFS[card.defId];
      const injuredUntil = state?.injuredUntil ?? 0;
      const isInjured = injuredUntil > now;
      const inTeam = !!state?.teamId;
      const pad = 10;

      const border = isInjured ? C.red : (inTeam ? C.accent : C.mid);
      const cell = sketchPanel(cellW, CARD_CELL_H, { fill: 0xfaf9f5, border, seed: seedFor(x, y, cellW) });
      cell.x = x; cell.y = y;
      this.bodyLayer.addChild(cell);

      // ── Left: full-height portrait in a light frame (portrait spans the whole cell height) ──
      const imgH = CARD_CELL_H - pad * 2;
      const imgW = Math.round(imgH * 0.72); // portrait-tall frame (unit art is taller than wide)
      const imgX = x + pad;
      const imgY = y + pad;
      const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
      frame.x = imgX; frame.y = imgY;
      this.bodyLayer.addChild(frame);
      const artUrl = cardInstanceArtUrl(card) ?? undefined;
      if (artUrl) this.drawArtFit(artUrl, imgX + 2, imgY + 2, imgW - 4, this.bodyLayer, imgH - 4);

      // ── Right: info column (name at top, stats stacked below) ──
      const ax = imgX + imgW + 12;
      const rightW = x + cellW - pad - ax; // available text width to the right of the portrait

      // Name row: faction dot + name (name clipped so long names don't overrun the column). The
      // dense roster rows keep a plain colour dot — the full totem (detail modal) is unreadable this
      // small; here colour alone conveys faction. Colour still comes from the one FACTION_COLOR source.
      const dot = new PIXI.Graphics();
      dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
      dot.x = ax + 5; dot.y = y + pad + 7;
      this.bodyLayer.addChild(dot);

      const cardName = t(`card.${card.defId}.name` as TranslationKey);
      const nameLbl = txt(cardName, FS.bodyLg, C.dark, true);
      nameLbl.x = ax + 16; nameLbl.y = y + pad;
      nameLbl.style.wordWrap = false;
      // Leave room for the lock badge on the name row when locked.
      const nameMaxW = rightW - 16 - (card.locked ? 24 : 0);
      if (nameLbl.width > nameMaxW) nameLbl.scale.set(Math.min(1, nameMaxW / nameLbl.width));
      this.bodyLayer.addChild(nameLbl);

      // Lock badge (top-right of the info column).
      if (card.locked) {
        const lk = buildIcon('lock', 18, C.mid);
        lk.x = x + cellW - pad - 18; lk.y = y + pad;
        this.bodyLayer.addChild(lk);
      }

      let ay = y + pad + 34;
      // Level as a row of gold stars, not a small "Lv.N" — level is the headline stat and a lone
      // number was too easy to overlook. One filled star per level (max 9); the row shrinks to fit
      // the info column so high-level cards still stay on one line.
      const stars = new PIXI.Container();
      stars.name = 'levelStars'; // test hook: one child per level star (see cardSceneLevelStars.ui.ts)
      const starN = Math.max(1, Math.min(9, card.level));
      const starSize = 15;
      const starGap = 3;
      for (let i = 0; i < starN; i++) {
        const st = buildIcon('star', starSize, C.gold);
        st.x = i * (starSize + starGap);
        stars.addChild(st);
      }
      const starsW = starN * starSize + (starN - 1) * starGap;
      if (starsW > rightW) stars.scale.set(rightW / starsW);
      stars.x = ax; stars.y = ay;
      this.bodyLayer.addChild(stars);
      ay += 24;

      const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
      const pwrLbl = txt(`${t('roster.power')} ${power}`, FS.small, C.dark);
      pwrLbl.x = ax; pwrLbl.y = ay; this.bodyLayer.addChild(pwrLbl);
      ay += 24;

      const atkLbl = txt(`${t('roster.atk')} ${cardAttack(card)}`, FS.small, C.dark);
      atkLbl.x = ax; atkLbl.y = ay; this.bodyLayer.addChild(atkLbl);
      ay += 24;

      const hpLbl = txt(`${t('roster.hp')} ${cardHp(card)}`, FS.small, C.dark);
      hpLbl.x = ax; hpLbl.y = ay; this.bodyLayer.addChild(hpLbl);
      ay += 24;

      if (def && state !== undefined) {
        const cap = troopCap(card);
        const cur = state.currentTroops;
        const troopLbl = txt(`${cur}/${cap}`, FS.small, cur >= cap ? C.gold : C.mid);
        troopLbl.x = ax; troopLbl.y = ay; this.bodyLayer.addChild(troopLbl);
        ay += 24;
      }

      // Status tag (deployed / injured) — named to the actual team when the caller can resolve it.
      // Deployed gets a bit of extra breathing room above it so it doesn't read as just another stat row.
      if (inTeam) {
        ay += 6;
        const teamName = state?.teamId ? this.cb.getTeamName?.(state.teamId) : undefined;
        const tagText = teamName ? t('roster.inTeamNamed').replace('{team}', teamName) : t('roster.inTeam');
        const tag = txt(`[${tagText}]`, FS.tiny, C.accent, true);
        if (tag.width > rightW) tag.scale.set(Math.max(0.01, rightW / tag.width));
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 20;
      } else if (isInjured) {
        const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, FS.tiny, C.red);
        tag.x = ax; tag.y = ay; this.bodyLayer.addChild(tag); ay += 20;
      }

      // Gear slot icons (weapon/armor/trinket) — the actual equipped item art, or the
      // hollow "+" placeholder when the slot is empty (matches renderDetailGearSlots'
      // treatment). buildEquipIcon already renders empty slots as a distinct outline
      // glyph, so no extra dimming is needed here (a dimmed real-item glyph used to
      // read as a low-rarity equipped item at a glance). Sized 2x the original 22px
      // badges so rarity/art actually reads at this density; the row shrinks (never
      // below the old 22px) rather than spill onto the portrait if the info column is
      // ever too narrow to fit it.
      const gearIconSizeTarget = 44;
      const gearGapTarget = 4;
      const gearRowWTarget = gearIconSizeTarget * 3 + gearGapTarget * 2;
      const gearScale = gearRowWTarget > rightW ? Math.max(0.5, rightW / gearRowWTarget) : 1;
      const gearIconSize = gearIconSizeTarget * gearScale;
      const gearStep = gearIconSize + gearGapTarget * gearScale;
      const gearCenterY = y + CARD_CELL_H - pad - gearIconSize / 2;
      (['weapon', 'armor', 'trinket'] as EquipSlot[]).forEach((slot, i) => {
        const instId = card.gear[slot];
        const inst = instId ? save.equipmentInv?.[instId] : undefined;
        const icon = buildEquipIcon(inst?.defId, slot, inst?.rarity ?? 'common', gearIconSize, seedFor(x, y, i + 1));
        icon.name = `gearIcon:${slot}`; // test hook: see gearIconSize2x.ui.ts
        const iconCx = x + cellW - pad - gearIconSize / 2 - (2 - i) * gearStep;
        icon.position.set(iconCx, gearCenterY);
        this.bodyLayer.addChild(icon);

        // Each gear icon jumps straight to that slot in EquipmentScene (matches the
        // detail modal's per-slot taps, renderDetailGearSlots in detail.ts) instead of
        // only opening via the whole-cell tap — the icons looked like buttons but
        // weren't actually clickable, which was part of why their intent read as
        // unclear (roster feedback 2026-08-01). Pushed before the whole-cell hitRect
        // below so it wins the first-match hit test.
        if (this.cb.openEquipment && !this.bt.busy) {
          this.hitRects.push({
            rect: { x: iconCx - gearIconSize / 2, y: gearCenterY - gearIconSize / 2, w: gearIconSize, h: gearIconSize },
            action: () => this.cb.openEquipment!(card.id, slot),
            owner: card.id,
          });
        }
      });

      this.hitRects.push({
        rect: { x, y, w: cellW, h: CARD_CELL_H },
        action: () => this.openDetail(card.id),
        owner: card.id,
      });
    }
  };
}
