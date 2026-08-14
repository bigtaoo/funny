// Roster list view: the [Cards|Equipment] sidebar rail, the header currency/capacity readout, the
// scrolling icon-card grid, and the per-card cell renderer. Depends on DetailPanel (openDetail) —
// see ../CardScene.ts assembly for the construction order.
import * as PIXI from 'pixi.js-legacy';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, tearDownChildren } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildLevelStars } from '../../render/levelStars';
import { buildEquipIcon } from '../../render/atlas/equipmentAtlas';
import { FACTION_COLOR } from '../../render/factionIcon';
import { cardInstanceArtUrl } from '../../render/cardArt';
import { drawHeaderCurrency } from '../../ui/widgets/SceneHeader';
import { drawSidebarTabs, drawBottomNavTabs, sidebarNavW, bottomNavH, type HubTab } from '../../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import type { SaveData, CardInstance, EquipSlot } from '../../game/meta/SaveData';
import type { CardSLGState } from '../../net/WorldApiClient';
import { CARD_DEFS, CARD_INV_CAP, CARD_INV_OVERFLOW_BUFFER, MAX_CARD_LEVEL, troopCap, cardPower, cardAttack, cardHp } from '../../game/meta/cardDefs';
import { CardSceneCore, CARD_CELL_H, CARD_CELL_W_TARGET, sortCards, injuryCountdown } from './core';
import type { DetailPanel } from './detail';

// Roster grid packs a fixed 5 cards per row (was auto-fit ~6) with roomier gaps than the shared CELL_GAP.
const ROSTER_COLS = 5;
const ROSTER_GAP = 24;

/** List domain (see ../CardScene.ts assembly + ./core.ts for the shared state). */
export class ListPanel {
  /**
   * Per-card cell container + on-screen rect from the last renderList layout pass — lets
   * applyCardState()/refreshCardCell() redraw a single cell in place (SLG border/troop/team-tag
   * only) instead of a full relayout when cb.getCardState() data changes after the roster is
   * already open. Repopulated on every renderList pass; a card's cell position/size never
   * depends on SLG state, so there's no need to invalidate these across a state-only refresh.
   */
  private cellContainers = new Map<string, PIXI.Container>();
  private cellRects = new Map<string, { x: number; y: number; w: number }>();

  constructor(
    private readonly core: CardSceneCore,
    private readonly detail: DetailPanel,
  ) {}

  /**
   * Redraw one roster cell in place (its SLG-derived border/troop-count/deployed-tag) — see
   * applyCardState(). Returns false (caller has nothing to fall back to; the cell just stays as
   * last rendered) when the cell isn't currently tracked, e.g. scrolled out of view since the
   * last full render.
   */
  private refreshCardCell(cardId: string): boolean {
    const core = this.core;
    const container = this.cellContainers.get(cardId);
    const rect = this.cellRects.get(cardId);
    if (!container || container.destroyed || !rect) return false;
    const save = core.cb.getSave();
    const card = save.cardInv?.[cardId];
    if (!card) return false;

    tearDownChildren(container);
    core.hitRects = core.hitRects.filter((h) => h.owner !== cardId);
    const state = core.cb.getCardState?.()?.[cardId];
    const outerLayer = core.bodyLayer;
    core.bodyLayer = container;
    this.renderCardCell(card, rect.x, rect.y, rect.w, state, Date.now(), save);
    core.bodyLayer = outerLayer;
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
    const core = this.core;
    if (core.tab !== 'list') return;
    for (const cardId of this.cellContainers.keys()) this.refreshCardCell(cardId);
    // Same fuseRingOpen guard as the assembly's render() modal dispatch (2026-08-03 fix) — a late
    // SLG fetch resolving while the fusion ring is open must not reopen the plain detail popup over it.
    if (core.detailId && !core.fuseRingOpen) this.detail.openDetail(core.detailId);
  }

  /**
   * Progression group nav [Cards|Equipment?|Skins] (LOBBY_IA_REDESIGN §15). Landscape draws a
   * vertical rail stacked inside the left notebook-margin gutter (`marginLineX`), below the
   * header; portrait draws it as a bottom nav bar instead (§18). Equipment only appears when
   * injected (openEquipmentBag, server-authoritative → online-only); Cards/Skins are always
   * reachable (including offline, reading the local save mirror).
   */
  renderSidebar(): void {
    const core = this.core;
    const { w, h, landscape } = core;
    const hasEquip = !!core.cb.openEquipmentBag;
    const tabs: HubTab[] = [
      { label: t('roster.title'), active: core.tab === 'list', icon: 'rosterIcon' },
      ...(hasEquip ? [{ label: t('equip.title'), active: false, icon: 'equipIcon' as const }] : []),
      { label: t('roster.tab.skins'), active: core.tab === 'skins', icon: 'skinIcon' },
    ];
    const onSelect = (i: number): void => {
      if (i === 0) { core.tab = 'list'; core.render(); return; }
      if (hasEquip && i === 1) { core.cb.openEquipmentBag?.(); return; }
      core.tab = 'skins'; core.render();
    };
    if (!landscape) {
      const barH = bottomNavH(h);
      const { hits } = drawBottomNavTabs(core.bodyLayer, w, h - barH, barH, tabs, onSelect);
      for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
      return;
    }
    const sidebarW = sidebarNavW(w, h, true);
    const { hits } = drawSidebarTabs(core.bodyLayer, sidebarW, core.headerH, h, tabs, onSelect);
    for (const hit of hits) core.hitRects.push({ rect: hit.rect, action: hit.fn });
  }

  /**
   * Coin balance + card-capacity readout drawn into the header row itself (same treatment as
   * EquipmentScene's renderHeaderCurrency), so the currency HUD stays visible and aligned with
   * the title when navigating between the card-inventory/equipment peer scenes instead of popping in/out.
   */
  renderHeaderCurrency(): void {
    const core = this.core;
    tearDownChildren(core.headerOverlayLayer);
    const save = core.cb.getSave();
    const count = Object.keys(save.cardInv ?? {}).length;
    const warn = count >= CARD_INV_CAP - CARD_INV_OVERFLOW_BUFFER;
    const full = count >= CARD_INV_CAP;
    // Keep the coin + capacity readout at a compact absolute size (matches EquipmentScene, its
    // [Cards|Equipment] peer) rather than scaling it up with the taller unified header.
    drawHeaderCurrency(core.headerOverlayLayer, core.w, core.headerH, save.wallet.coins, [], {
      text: `${t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP))}`,
      color: full ? C.red : warn ? C.gold : C.mid,
    }, 100 / core.headerH);
  }

  renderList(): void {
    const core = this.core;
    const { w, h } = core;
    const save = core.cb.getSave();
    const cardState = core.cb.getCardState?.() ?? {};
    const cards = Object.values(save.cardInv ?? {});
    const listY = core.headerH;
    // Portrait's sidebar nav is a bottom bar instead (§18) — reserve bottomNavH off the height
    // (the sidebar always shows, so this always applies in portrait) instead of width.
    const availH = h - listY - 8 - (core.landscape ? 0 : bottomNavH(h));

    if (cards.length === 0) {
      const lbl = txt(t('roster.empty'), FS.heading, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = listY + availH / 2;
      lbl.style.wordWrap = true; lbl.style.wordWrapWidth = w - 32;
      core.bodyLayer.addChild(lbl);
      core.maxScroll = 0;
      this.cellContainers = new Map();
      this.cellRects = new Map();
      return;
    }

    const sorted = sortCards(cards, save.equipmentInv ?? {}, cardState);
    // Landscape starts the grid right of the sidebar rail; portrait has no side rail (the nav
    // moves to a bottom bar, §18) so the grid instead fills 90% of the screen width, centered —
    // same portrait content-column convention as Lobby's `fullContentW` (LobbyScene/build.ts) —
    // instead of the old notebook-margin-based left offset, which read as an off-center ~9%
    // left / ~2% right gap rather than a deliberately inset column (2026-08-09 fix).
    let left: number, avail: number;
    if (core.landscape) {
      left = sidebarNavW(w, h, true) + ROSTER_GAP;
      avail = w - left - ROSTER_GAP;
    } else {
      avail = Math.round(w * 0.9);
      left = Math.round((w - avail) / 2);
    }
    // Fixed 5-per-row roster (was auto-fit ~6): wider cards, roomier gaps. Clamp down on narrow viewports.
    const cols = Math.max(1, Math.min(ROSTER_COLS, Math.floor((avail + ROSTER_GAP) / (CARD_CELL_W_TARGET + ROSTER_GAP))));
    const cellW = (avail - ROSTER_GAP * (cols - 1)) / cols;
    const rows = Math.ceil(sorted.length / cols);
    const totalH = rows * (CARD_CELL_H + ROSTER_GAP) + ROSTER_GAP;
    // Row visibility below is still draw-cull only (a row either draws in full or is skipped
    // entirely, never cropped) — see renderCardCell. peekViewportH's mid-row shrink is for grids
    // that *rely on* that crop to show a genuine partial row; applied here it would just exclude a
    // row that would otherwise render in full within the naive viewport, leaving a dead gap at the
    // bottom that pops the row in only once scrolling pushes it past the shrunk cutoff (2026-07-23
    // roster bug) — so availH stays the plain reserved height, not a peekViewportH() result.
    // Also the wheel-scroll viewport bounds, see wheelScroll.ts.
    const maxScroll = Math.max(0, totalH - availH);
    core.scrollY = Math.max(0, Math.min(core.scrollY, maxScroll));
    core.scrollRegionTop = listY;
    core.scrollRegionBottom = listY + availH;
    core.maxScroll = maxScroll;

    const now = Date.now();
    this.cellContainers = new Map();
    this.cellRects = new Map();
    const outerLayer = core.bodyLayer;
    // Cards draw into a masked sub-layer so a row straddling the availH edge (still counted
    // "visible" by the draw-cull check above, since only its *top* has to be within bounds) never
    // bleeds past listY+availH and paints over the portrait bottom nav bar drawn just below it —
    // mirrors EquipmentScene InventoryMixin's identical gridLayer/clip treatment (2026-08-09 fix).
    const gridLayer = new PIXI.Container();
    outerLayer.addChild(gridLayer);
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(0, listY, w, availH).endFill();
    outerLayer.addChild(clip);
    gridLayer.mask = clip;
    core.bodyLayer = gridLayer;
    sorted.forEach((card, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = left + col * (cellW + ROSTER_GAP);
      const y = listY + ROSTER_GAP + row * (CARD_CELL_H + ROSTER_GAP) - core.scrollY;
      if (y + CARD_CELL_H >= listY && y <= listY + availH) {
        // Each cell renders into its own container (child of gridLayer) so a later
        // applyCardState() can tear down and redraw just this one cell — see refreshCardCell().
        const cellC = new PIXI.Container();
        gridLayer.addChild(cellC);
        this.cellContainers.set(card.id, cellC);
        this.cellRects.set(card.id, { x, y, w: cellW });
        core.bodyLayer = cellC;
        this.renderCardCell(card, x, y, cellW, cardState[card.id], now, save);
        core.bodyLayer = gridLayer;
      }
    });
    core.bodyLayer = outerLayer;

    drawScrollIndicator(core.bodyLayer, { x: left, y: listY, w: avail, h: availH }, core.scrollY, Math.max(0, totalH - availH));
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
    const core = this.core;
    const def = CARD_DEFS[card.defId];
    const injuredUntil = state?.injuredUntil ?? 0;
    const isInjured = injuredUntil > now;
    const inTeam = !!state?.teamId;
    const pad = 10;

    const border = isInjured ? C.red : (inTeam ? C.accent : C.mid);
    const cell = sketchPanel(cellW, CARD_CELL_H, { fill: 0xfaf9f5, border, seed: seedFor(x, y, cellW) });
    cell.x = x; cell.y = y;
    core.bodyLayer.addChild(cell);

    // ── Left: full-height portrait in a light frame (portrait spans the whole cell height) ──
    const imgH = CARD_CELL_H - pad * 2;
    const imgW = Math.round(imgH * 0.72); // portrait-tall frame (unit art is taller than wide)
    const imgX = x + pad;
    const imgY = y + pad;
    const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
    frame.x = imgX; frame.y = imgY;
    core.bodyLayer.addChild(frame);
    const artUrl = cardInstanceArtUrl(card) ?? undefined;
    if (artUrl) core.drawArtFit(artUrl, imgX + 2, imgY + 2, imgW - 4, core.bodyLayer, imgH - 4);

    // ── Right: info column (name at top, stats stacked below) ──
    const ax = imgX + imgW + 12;
    const rightW = x + cellW - pad - ax; // available text width to the right of the portrait

    // Name row: faction dot + name (name clipped so long names don't overrun the column). The
    // dense roster rows keep a plain colour dot — the full totem (detail modal) is unreadable this
    // small; here colour alone conveys faction. Colour still comes from the one FACTION_COLOR source.
    const dot = new PIXI.Graphics();
    dot.beginFill(FACTION_COLOR[def?.faction ?? 'tao']).drawCircle(0, 0, 5).endFill();
    dot.x = ax + 5; dot.y = y + pad + 7;
    core.bodyLayer.addChild(dot);

    const cardName = t(`card.${card.defId}.name` as TranslationKey);
    const nameLbl = txt(cardName, FS.bodyLg, C.dark, true);
    nameLbl.x = ax + 16; nameLbl.y = y + pad;
    nameLbl.style.wordWrap = false;
    // Leave room for the lock badge on the name row when locked.
    const nameMaxW = rightW - 16 - (card.locked ? 24 : 0);
    if (nameLbl.width > nameMaxW) nameLbl.scale.set(Math.min(1, nameMaxW / nameLbl.width));
    core.bodyLayer.addChild(nameLbl);

    // Lock badge (top-right of the info column).
    if (card.locked) {
      const lk = buildIcon('lock', 18, C.mid);
      lk.x = x + cellW - pad - 18; lk.y = y + pad;
      core.bodyLayer.addChild(lk);
    }

    let ay = y + pad + 34;
    // Level as a row of gold stars, not a small "Lv.N" — level is the headline stat and a lone
    // number was too easy to overlook. One filled star per level (max MAX_CARD_LEVEL); the row
    // shrinks to fit the info column so high-level cards still stay on one line.
    const starN = Math.max(1, Math.min(MAX_CARD_LEVEL, card.level));
    const { container: stars } = buildLevelStars(starN, rightW, 15, 3);
    stars.name = 'levelStars'; // test hook: one child per level star (see cardSceneLevelStars.ui.ts)
    stars.x = ax; stars.y = ay;
    core.bodyLayer.addChild(stars);
    ay += 24;

    const power = Math.round(cardPower(card, save.equipmentInv ?? {}));
    const pwrLbl = txt(`${t('roster.power')} ${power}`, FS.small, C.dark);
    pwrLbl.x = ax; pwrLbl.y = ay; core.bodyLayer.addChild(pwrLbl);
    ay += 24;

    const atkLbl = txt(`${t('roster.atk')} ${cardAttack(card)}`, FS.small, C.dark);
    atkLbl.x = ax; atkLbl.y = ay; core.bodyLayer.addChild(atkLbl);
    ay += 24;

    const hpLbl = txt(`${t('roster.hp')} ${cardHp(card)}`, FS.small, C.dark);
    hpLbl.x = ax; hpLbl.y = ay; core.bodyLayer.addChild(hpLbl);
    ay += 24;

    if (def && state !== undefined) {
      const cap = troopCap(card);
      const cur = state.currentTroops;
      const troopLbl = txt(`${cur}/${cap}`, FS.small, cur >= cap ? C.gold : C.mid);
      troopLbl.x = ax; troopLbl.y = ay; core.bodyLayer.addChild(troopLbl);
      ay += 24;
    }

    // Status tag (deployed / injured) — named to the actual team when the caller can resolve it.
    // Deployed gets a bit of extra breathing room above it so it doesn't read as just another stat row.
    if (inTeam) {
      ay += 6;
      const teamName = state?.teamId ? core.cb.getTeamName?.(state.teamId) : undefined;
      const tagText = teamName ? t('roster.inTeamNamed').replace('{team}', teamName) : t('roster.inTeam');
      const tag = txt(`[${tagText}]`, FS.tiny, C.accent, true);
      if (tag.width > rightW) tag.scale.set(Math.max(0.01, rightW / tag.width));
      tag.x = ax; tag.y = ay; core.bodyLayer.addChild(tag); ay += 20;
    } else if (isInjured) {
      const tag = txt(`[${t('roster.injured').replace('{time}', injuryCountdown(injuredUntil, now))}]`, FS.tiny, C.red);
      tag.x = ax; tag.y = ay; core.bodyLayer.addChild(tag); ay += 20;
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
      core.bodyLayer.addChild(icon);

      // Each gear icon jumps straight to that slot in EquipmentScene (matches the
      // detail modal's per-slot taps, renderDetailGearSlots in detail.ts) instead of
      // only opening via the whole-cell tap — the icons looked like buttons but
      // weren't actually clickable, which was part of why their intent read as
      // unclear (roster feedback 2026-08-01). Pushed before the whole-cell hitRect
      // below so it wins the first-match hit test.
      if (core.cb.openEquipment && !core.bt.busy) {
        core.hitRects.push({
          rect: { x: iconCx - gearIconSize / 2, y: gearCenterY - gearIconSize / 2, w: gearIconSize, h: gearIconSize },
          action: () => core.cb.openEquipment!(card.id, slot),
          owner: card.id,
        });
      }
    });

    core.hitRects.push({
      rect: { x, y, w: cellW, h: CARD_CELL_H },
      action: () => this.detail.openDetail(card.id),
      owner: card.id,
    });
  }
}
