import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildIcon } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { sidebarNavW } from '../ui/widgets/HubTabs';
import { sortTitlesByWeight, getTitleKeys, formatLadderTitle, allTitleIds } from '../game/meta/titles';

// ── TitlesScene — title wall (S10, TITLE_DESIGN §7/§9) ────────────────────────────
//
// Entry: StatsScene → onOpenTitles.
// Displays: the full title catalog (allTitleIds — fixed event/achievement titles always
// listed, plus any owned seasonal ones), sorted by weight descending; ungained titles are
// greyed out and non-interactive. Which title (if any) is shown is entirely the player's
// choice — tap an owned title to equip it, tap the equipped one again to unequip (blank).
// Interaction: tap a title row → update equipped['title'] (PUT /save, client-side sync segment).

export interface TitlesSceneCallbacks {
  onBack(): void;
  /** List of title ids owned by the player (from save.titles). */
  titles: string[];
  /** Currently equipped title id (save.equipped['title']). */
  equippedTitle: string;
  /** Equip a new title → write equipped['title'] + PUT /save. */
  onEquip(titleId: string): void;
  /**
   * Career hub peer navigation (LOBBY_IA_REDESIGN P1.5): when both are present, a
   * [Stats|Titles|Achievements] strip is drawn in the left margin gutter, itself active. Omitted from
   * standalone entry points that shouldn't advertise the sibling pages.
   */
  onOpenStats?(): void;
  onOpenAchievements?(): void;
  /** Open the card codex (LOBBY_IA_REDESIGN §15, folded in from the retired CollectionScene). */
  onOpenCodex?(): void;
  /** Red dot on the achievements peer tab when any tier is claimable. */
  hasClaimableAchievement?: boolean;
}

interface Hit { rect: Rect; fn: () => void; }

export class TitlesScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: TitlesSceneCallbacks;
  private readonly landscape: boolean;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: TitlesSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.landscape = layout.orientation === 'landscape';

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
  }

  update(_dt: number): void {}

  destroy(): void {
    this.unsubs.forEach((u) => u());
    tearDownChildren(this.container);
  }

  private handleDown(x: number, y: number): void {
    for (const h of this.hits) {
      if (x >= h.rect.x && x <= h.rect.x + h.rect.w && y >= h.rect.y && y <= h.rect.y + h.rect.h) {
        h.fn();
        return;
      }
    }
  }

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawSidebar(tbH);
    this.drawTitleList();
  }

  private drawBackground(): void {
    const { w, h, landscape } = this;
    // Landscape only for now, and only when the Career hub peer strip is actually shown — see
    // ShopScene.drawBackground / LOBBY_IA_REDESIGN §14.
    const hasSidebar = !!(this.cb.onOpenStats && this.cb.onOpenAchievements && this.cb.onOpenCodex);
    const railX = landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    const bg = buildPaperBackground('titlesbg', w, h, { railX });
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): number {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('titles.title'));
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
    return hdr.headerH;
  }

  /**
   * Career hub peer strip [Stats|Titles|Achievements] in the left margin gutter (see StatsScene /
   * CareerTabs.ts); only drawn when the caller wired both sibling callbacks.
   */
  private drawSidebar(tbH: number): void {
    if (!this.cb.onOpenStats || !this.cb.onOpenAchievements || !this.cb.onOpenCodex) return;
    const { w, h } = this;
    const sidebarW = sidebarNavW(w, h, this.landscape);
    const sidebarTop = tbH + Math.round(h * 0.02);
    const { hits } = drawCareerTabs(this.container, sidebarW, sidebarTop, h, 'titles', {
      onOpenStats: this.cb.onOpenStats,
      onOpenTitles: () => {},
      onOpenAchievements: this.cb.onOpenAchievements,
      onOpenCodex: this.cb.onOpenCodex,
      hasClaimableAchievement: this.cb.hasClaimableAchievement,
    });
    this.hits.push(...hits);
  }

  /** Icon-card grid, packed left-to-right/top-to-bottom into as many columns as fit — mirrors the
   *  Equipment/Roster/Auction card-grid convention used elsewhere in the Career hub. */
  private drawTitleList(): void {
    const { w, h } = this;
    const hasSidebar = !!this.cb.onOpenStats && !!this.cb.onOpenAchievements && !!this.cb.onOpenCodex;
    const tbH = Math.round(h * 0.12);
    const padX = hasSidebar ? sidebarNavW(w, h, this.landscape) + Math.round(w * 0.025) : Math.round(w * 0.08);
    const padRight = hasSidebar ? Math.round(w * 0.04) : Math.round(w * 0.08);
    const gridTop = tbH + Math.round(h * 0.04);
    const gridW = w - padX - padRight;
    const owned = new Set(this.cb.titles);
    const sorted = sortTitlesByWeight(allTitleIds(this.cb.titles));

    if (sorted.length === 0) {
      const empty = txt(t('titles.empty'), Math.round(h * 0.032), C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = w / 2; empty.y = h / 2;
      this.container.addChild(empty);
      return;
    }

    const gap = Math.round(h * 0.03);
    const cellWTarget = Math.round(w * 0.17);
    const cellH = Math.round(h * 0.32);
    const cols = Math.max(1, Math.floor((gridW + gap) / (cellWTarget + gap)));
    const cellW = Math.min(cellWTarget, (gridW - gap * (cols - 1)) / cols);

    sorted.forEach((titleId, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padX + col * (cellW + gap);
      const y = gridTop + row * (cellH + gap);
      this.drawTitleCard(titleId, x, y, cellW, cellH, owned.has(titleId));
    });
  }

  /**
   * One title as an icon card: medal glyph on top, short/full labels below, status badge at the
   * bottom. Locked cards are greyed + non-interactive; owned cards are always tappable —
   * unequipped → equip, equipped → tap again to unequip (blank display is allowed).
   */
  private drawTitleCard(titleId: string, x: number, y: number, cellW: number, cellH: number, isOwned: boolean): void {
    const equipped = titleId === this.cb.equippedTitle;
    const color = equipped ? C.gold : isOwned ? C.dark : C.mid;

    const card = sketchPanel(cellW, cellH, {
      fill: equipped ? 0xfef8e0 : C.paper,
      border: equipped ? C.gold : isOwned ? C.line : C.btnOff,
      width: equipped ? 2.5 : 1.5,
      seed: seedFor(x, y, cellW),
    });
    card.x = x; card.y = y;
    card.alpha = isOwned ? 1 : 0.5;
    this.container.addChild(card);

    const iconS = Math.round(cellH * 0.3);
    const icon = buildIcon('medal', iconS, color);
    icon.x = x + cellW / 2 - iconS / 2; icon.y = y + Math.round(cellH * 0.1);
    icon.alpha = isOwned ? 1 : 0.6;
    this.container.addChild(icon);

    const keys = getTitleKeys(titleId);
    const shortLabel = keys
      ? (t(keys.shortKey as import('../i18n').TranslationKey) || formatLadderTitle(titleId))
      : formatLadderTitle(titleId);
    const fullLabel = keys
      ? (t(keys.fullKey as import('../i18n').TranslationKey) || shortLabel)
      : shortLabel;

    const shortY = y + Math.round(cellH * 0.1) + iconS + Math.round(cellH * 0.05);
    const shortLbl = txt(`「${shortLabel}」`, Math.round(cellH * 0.11), color, equipped);
    shortLbl.anchor.set(0.5, 0); shortLbl.x = x + cellW / 2; shortLbl.y = shortY;
    if (shortLbl.width > cellW * 0.88) shortLbl.scale.set((cellW * 0.88) / shortLbl.width);
    shortLbl.alpha = isOwned ? 1 : 0.7;
    this.container.addChild(shortLbl);

    const fullLbl = txt(fullLabel, Math.round(cellH * 0.07), isOwned ? C.dark : C.mid, false, Math.round(cellW * 0.85));
    fullLbl.anchor.set(0.5, 0); fullLbl.x = x + cellW / 2; fullLbl.y = shortY + Math.round(cellH * 0.15);
    fullLbl.alpha = isOwned ? 0.85 : 0.65;
    this.container.addChild(fullLbl);

    if (!isOwned) {
      const badge = txt(t('titles.locked'), Math.round(cellH * 0.08), C.mid);
      badge.anchor.set(0.5, 1); badge.x = x + cellW / 2; badge.y = y + cellH - Math.round(cellH * 0.06);
      this.container.addChild(badge);
      return;
    }

    if (equipped) {
      const badge = txt(t('titles.equipped'), Math.round(cellH * 0.08), C.gold, true);
      badge.anchor.set(0.5, 1); badge.x = x + cellW / 2; badge.y = y + cellH - Math.round(cellH * 0.14);
      this.container.addChild(badge);
      const hint = txt(t('titles.tapUnequip'), Math.round(cellH * 0.06), C.mid);
      hint.anchor.set(0.5, 1); hint.x = x + cellW / 2; hint.y = y + cellH - Math.round(cellH * 0.06);
      this.container.addChild(hint);
    }

    this.hits.push({
      rect: { x, y, w: cellW, h: cellH },
      fn: () => {
        this.cb.onEquip(equipped ? '' : titleId);
        this.render();
      },
    });
  }
}
