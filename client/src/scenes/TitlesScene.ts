import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, txtFit, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildIcon, IconKind } from '../render/icons';
import { titleIconUrl, getTitleIconTexture } from '../render/titleArt';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs } from '../ui/widgets/CareerTabs';
import { sidebarNavW, bottomNavH } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../ui/widgets/scrollPeek';
import { wheelScrollY } from '../ui/wheelScroll';
import { sortTitlesByWeight, getTitleKeys, formatLadderTitle, allTitleIds } from '../game/meta/titles';
import { FS, snapFont } from '../render/fontScale';
import { dispatchHit, type Hit } from '../ui/hits';

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


/** Dynamic (non-permanent) title fallback glyphs — see render/icons/titles.ts. */
const LADDER_RANK_ICON: Readonly<Record<string, IconKind>> = {
  bronze: 'titleBronze', silver: 'titleSilver', gold: 'titleGold', platinum: 'titlePlatinum',
  diamond: 'titleDiamond', star: 'titleStar', master: 'titleMaster', grandmaster: 'titleGrandmaster', king: 'titleKing',
};
const SLG_TITLE_ICON: Readonly<Record<string, IconKind>> = { champion: 'titleChampion', top3: 'titleTop3' };

/**
 * Pick the fallback glyph for a title with no bespoke AI art (titleIconUrl() === null): parse
 * the ladder rank / SLG key out of the dynamic id and map it to its distinct medal/shield glyph;
 * unrecognised ids (future title sources) fall back to the old undifferentiated 'medal'.
 */
function fallbackTitleIcon(titleId: string): IconKind {
  const lm = titleId.match(/^ladder\.s\d+\.(\w+)$/);
  if (lm) { const icon = LADDER_RANK_ICON[lm[1]!]; if (icon) return icon; }
  const sm = titleId.match(/^slg\.s\d+\.(\w+)$/);
  if (sm) { const icon = SLG_TITLE_ICON[sm[1]!]; if (icon) return icon; }
  return 'medal';
}

/**
 * Clamp the TOP of a card's bottom-anchored status block so it never overlaps content that ends at
 * `contentBottom` — the full-name label above it can word-wrap to extra lines on a narrow card
 * (long locale full names, e.g. "Notebook Conqueror", "Ranglistenprofi"), and the block must yield
 * downward past wherever that label actually ended instead of sitting at its usual fixed offset
 * from the card's bottom (2026-08-11 portrait title-wall overlap fix; applied to the badge AND the
 * hint as one group 2026-09-12, see `drawTitleCard`).
 *
 * Exported and pure so it can be unit-tested directly with plain numbers: PIXI's word-wrap under
 * the headless UI-test harness measures text width as a flat length-based approximation (see
 * test/harness/pixiHeadless.ts's `measureText`), which doesn't reproduce the character-width
 * growth a real font size triggers — so the actual multi-line wrap this fixes can't be reliably
 * reproduced through a full scene render in that harness. Testing this arithmetic in isolation
 * (test/titlesBadgeOverflow.test.ts) is what actually covers the fix; see also client-testing.md's
 * `judgeRunner.ts` `export`-for-testability precedent.
 */
export function badgeYBelowContent(preferredY: number, contentBottom: number, gap: number): number {
  return Math.max(preferredY, contentBottom + gap);
}

export class TitlesScene implements Scene {
  readonly container: PIXI.Container;
  /** Menu/shell screen: painted only when the stage changes (render/renderPolicy.ts). */
  readonly paint = 'reactive' as const;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: TitlesSceneCallbacks;
  private readonly landscape: boolean;

  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Art urls we've already hooked a 'loaded' re-render on — avoids stacking listeners. */
  private readonly artHooked = new Set<string>();
  private destroyed = false;

  // Grid scroll state (title catalog grows unboundedly with owned seasonal titles, so it can
  // overflow one screen) — drag-scroll + tap-vs-drag disambiguation, mirrors GachaScene's odds panel.
  private body: PIXI.Container = new PIXI.Container();
  private bodyMask: PIXI.Graphics | null = null;
  private scrollY = 0;
  private scrollMax = 0;
  private scrollDirty = false;
  private dragStart: { x: number; y: number; scroll: number; moved: boolean } | null = null;
  /** Grid viewport y-bounds (set each render by drawTitleList), gates mouse-wheel scroll (browser/PC only). */
  private regionTop = 0;
  private regionBottom = 0;

  constructor(layout: ILayout, input: InputManager, cb: TitlesSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.landscape = layout.orientation === 'landscape';

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.unsubs.push(input.onWheel((_x, y, deltaY) => this.handleWheel(y, deltaY)));
    this.render();
  }

  update(_dt: number): void {
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubs.forEach((u) => u());
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }

  private handleDown(x: number, y: number): void {
    this.dragStart = { x, y, scroll: this.scrollY, moved: false };
  }

  private handleMove(y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.dragStart.moved = true;
      this.scrollY = Math.max(0, Math.min(this.scrollMax, this.dragStart.scroll - dy));
      this.scrollDirty = true;
    }
  }

  private handleUp(x: number, y: number): void {
    if (this.dragStart && !this.dragStart.moved) {
      dispatchHit(this.hits, x, y);
    }
    this.dragStart = null;
  }

  /** Mouse-wheel scroll over the title grid (browser/PC only — see wheelScroll.ts). */
  private handleWheel(y: number, deltaY: number): void {
    const next = wheelScrollY(this.regionTop, this.regionBottom, y, deltaY, this.scrollY, this.scrollMax);
    if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
  }

  private render(): void {
    // The single throttle point for every redraw entry (菜单场景生命周期契约) — the card-art
    // 'loaded' hook below already guards itself, but the guard belongs here so any future deferred
    // redraw is covered without having to remember.
    if (this.destroyed) return;
    tearDownChildren(this.container);
    this.hits = [];

    this.drawBackground();
    const tbH = this.drawHeader();
    this.drawSidebar(tbH);

    // Grid lives in its own masked layer so overscrolled cards never bleed into the header/sidebar.
    this.body = new PIXI.Container();
    this.container.addChild(this.body);
    const mask = new PIXI.Graphics();
    this.container.addChild(mask);
    this.body.mask = mask;
    this.bodyMask = mask;

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
    const hdr = drawSceneHeader(this.container, w, h, t('titles.title'), { icon: 'honorTabIcon' });
    this.hits.push({ rect: hdr.backRect, sound: 'sfx.ui.back', fn: () => this.cb.onBack() });
    return hdr.headerH;
  }

  /**
   * Career hub peer strip [Stats|Titles|Achievements] in the left margin gutter (see StatsScene /
   * CareerTabs.ts); only drawn when the caller wired both sibling callbacks.
   */
  private drawSidebar(tbH: number): void {
    if (!this.cb.onOpenStats || !this.cb.onOpenAchievements || !this.cb.onOpenCodex) return;
    const { w, h, landscape } = this;
    const sidebarTop = tbH + Math.round(h * 0.02);
    const { hits } = drawCareerTabs(this.container, w, h, landscape, sidebarTop, 'titles', {
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
    const padX = this.landscape && hasSidebar ? sidebarNavW(w, h, true) + Math.round(w * 0.025) : Math.round(w * 0.08);
    const padRight = this.landscape && hasSidebar ? Math.round(w * 0.04) : Math.round(w * 0.08);
    const gridTop = tbH + Math.round(h * 0.04);
    const gridW = w - padX - padRight;
    const owned = new Set(this.cb.titles);
    const sorted = sortTitlesByWeight(allTitleIds(this.cb.titles));

    // Portrait's Career peer strip is a bottom nav bar (§18), not a left rail — the grid's masked
    // viewport must stop short of it or the last row(s) would scroll in behind the bar.
    const availH = h - gridTop - Math.round(h * 0.02) - (!this.landscape && hasSidebar ? bottomNavH(h) : 0);
    this.regionTop = gridTop;

    if (sorted.length === 0) {
      this.regionBottom = gridTop + availH;
      this.maskGrid(gridTop, availH);
      const empty = txt(t('titles.empty'), FS.title, C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = w / 2; empty.y = h / 2;
      this.body.addChild(empty);
      return;
    }

    const gap = Math.round(h * 0.03);
    const cellWTarget = Math.round(w * 0.17);
    // Card height must read off the design canvas's *short* edge, not raw `h` — designWidth/
    // designHeight swap meaning between orientations (portrait 1080x1920 vs landscape 1920x1080,
    // see ILayout.ts), so landscape's short edge is `h` but portrait's is `w`. Using `h` unconditionally
    // (as this used to) made portrait cards ~3.3x taller than wide instead of matching landscape's
    // near-square proportions — same class of bug CardCodexScene's tileH fixed (2026-08-09), applied
    // here 2026-08-11 after a portrait screenshot showed absurdly narrow, overlapping-text cards.
    const cellH = Math.round((this.landscape ? h : w) * 0.32);
    const cols = Math.max(1, Math.floor((gridW + gap) / (cellWTarget + gap)));
    const cellW = Math.min(cellWTarget, (gridW - gap * (cols - 1)) / cols);

    const rows = Math.ceil(sorted.length / cols);
    const totalH = rows * (cellH + gap);
    // Clamp the viewport so it always cuts mid-row when there's more below — a partial next card
    // stays visibly peeking above the fold instead of the thin ScrollIndicator being the only hint.
    const viewH = peekViewportH(availH, cellH + gap, totalH);
    this.regionBottom = gridTop + viewH;
    this.maskGrid(gridTop, viewH);
    this.scrollMax = Math.max(0, totalH - viewH);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));

    sorted.forEach((titleId, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padX + col * (cellW + gap);
      const y = gridTop + row * (cellH + gap) - this.scrollY;
      if (y + cellH >= gridTop && y <= gridTop + viewH) {
        this.drawTitleCard(titleId, x, y, cellW, cellH, owned.has(titleId));
      }
    });

    drawScrollIndicator(this.container, { x: padX, y: gridTop, w: gridW, h: viewH }, this.scrollY, this.scrollMax);
  }

  /** Size this render's grid mask to `top..top+viewH`, called once the peek-adjusted viewH is known. */
  private maskGrid(top: number, viewH: number): void {
    this.bodyMask?.clear().beginFill(0xffffff).drawRect(0, top, this.w, viewH).endFill();
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
    this.body.addChild(card);

    // ── The card is laid out labels-first, medal last ────────────────────────────────────────
    //
    // Every label under the medal is built (and therefore measured) before the medal is sized,
    // because the medal is the only element here with slack and the labels are the ones whose
    // height is a locale question. The full name wraps at `cellW * 0.85`, and an equipped card
    // carries a badge AND a hint beneath it: on a 390-wide phone that is a 184-px card holding
    // "Ranglistenprofi" (two lines) over "Angelegt" over the unequip hint — 30 design px more than
    // the card has. The badge used to be placed at a fixed offset from the card's bottom with no
    // idea of any of that, and was drawn straight through the name (sweep §50.12; the `contentBottom`
    // clamp below already protected the HINT, which is why only the badge collided).
    const topPad = Math.round(cellH * 0.06);
    const afterIconGap = Math.round(cellH * 0.04);
    const shortLineH = Math.round(cellH * 0.15);
    const botPad = Math.round(cellH * 0.06);
    const aboveBottomGap = Math.round(cellH * 0.03);
    const badgeHintGap = Math.round(cellH * 0.02);

    const keys = getTitleKeys(titleId);
    const shortLabel = keys
      ? (t(keys.shortKey as import('../i18n').TranslationKey) || formatLadderTitle(titleId))
      : formatLadderTitle(titleId);
    const fullLabel = keys
      ? (t(keys.fullKey as import('../i18n').TranslationKey) || shortLabel)
      : shortLabel;

    const fullLbl = txt(fullLabel, snapFont(Math.round(cellH * 0.07)), isOwned ? C.dark : C.mid, false, Math.round(cellW * 0.85));
    fullLbl.anchor.set(0.5, 0); fullLbl.x = x + cellW / 2;
    fullLbl.alpha = isOwned ? 0.85 : 0.65;

    // Bottom block: a locked card shows one badge, an equipped one a badge over a hint, an owned
    // idle one neither. `txtFit` on the hint because it is the longest string on the card and the
    // only one with nowhere to wrap to — it steps down the scale and, at the floor, elides.
    const badge = !isOwned
      ? txt(t('titles.locked'), snapFont(Math.round(cellH * 0.08)), C.mid)
      : equipped
        ? txt(t('titles.equipped'), snapFont(Math.round(cellH * 0.08)), C.gold, true)
        : null;
    const hint = isOwned && equipped
      ? txtFit(t('titles.tapUnequip'), snapFont(Math.round(cellH * 0.06)), C.mid, false, Math.round(cellW * 0.9))
      : null;
    const bottomH = (badge ? badge.height : 0) + (hint ? badgeHintGap + hint.height : 0);

    // Medal art is tall portrait (~0.5 aspect); fit it into the icon box preserving aspect so it
    // isn't squashed into a square. Box gets the top ~44% of the card, or whatever the labels leave
    // — but never below 0.28, past which it stops reading as a medal and the honest failure is the
    // labels crowding again rather than the picture quietly vanishing.
    const boxH = Math.round(Math.max(
      cellH * 0.28,
      Math.min(
        cellH * 0.44,
        cellH - topPad - afterIconGap - shortLineH - fullLbl.height - aboveBottomGap - bottomH - botPad,
      ),
    ));
    const boxMaxW = Math.round(cellW * 0.7);
    const iconTop = y + topPad;
    const iconUrl = titleIconUrl(titleId);
    if (iconUrl) {
      const tex = getTitleIconTexture(iconUrl);
      if (tex.baseTexture.valid) {
        const aspect = tex.width / tex.height;
        let ih = boxH;
        let iw = ih * aspect;
        if (iw > boxMaxW) { iw = boxMaxW; ih = iw / aspect; }
        const sprite = new PIXI.Sprite(tex);
        sprite.width = iw; sprite.height = ih;
        sprite.tint = color;
        sprite.x = x + cellW / 2 - iw / 2;
        sprite.y = iconTop + (boxH - ih) / 2;
        sprite.alpha = isOwned ? 1 : 0.6;
        this.body.addChild(sprite);
      } else if (!this.artHooked.has(iconUrl)) {
        // Sizing against an unloaded (0/1px) baseTexture yields garbage — re-render once it loads.
        this.artHooked.add(iconUrl);
        tex.baseTexture.once('loaded', () => { if (!this.destroyed) this.render(); });
      }
    } else {
      const iconS = Math.min(boxH, boxMaxW);
      const icon = buildIcon(fallbackTitleIcon(titleId), iconS, color);
      icon.x = x + cellW / 2 - iconS / 2; icon.y = iconTop + (boxH - iconS) / 2;
      icon.alpha = isOwned ? 1 : 0.6;
      this.body.addChild(icon);
    }

    const shortY = iconTop + boxH + afterIconGap;
    const shortLbl = txt(`「${shortLabel}」`, snapFont(Math.round(cellH * 0.11)), color, equipped);
    shortLbl.anchor.set(0.5, 0); shortLbl.x = x + cellW / 2; shortLbl.y = shortY;
    if (shortLbl.width > cellW * 0.88) shortLbl.scale.set((cellW * 0.88) / shortLbl.width);
    shortLbl.alpha = isOwned ? 1 : 0.7;
    this.body.addChild(shortLbl);

    fullLbl.y = shortY + shortLineH;
    this.body.addChild(fullLbl);

    // The bottom block sits at its usual offset from the card's bottom, and yields downward as ONE
    // group when the wrapped name above reaches into it (2026-08-11 portrait title-wall fix,
    // extended to the badge 2026-09-12 — it used to be positioned relative to the hint, i.e. back
    // UP into the content the hint had just cleared).
    if (badge || hint) {
      const blockTop = badgeYBelowContent(
        y + cellH - botPad - bottomH, fullLbl.y + fullLbl.height, aboveBottomGap,
      );
      if (badge) {
        badge.anchor.set(0.5, 0); badge.x = x + cellW / 2; badge.y = blockTop;
        this.body.addChild(badge);
      }
      if (hint) {
        hint.anchor.set(0.5, 0); hint.x = x + cellW / 2;
        hint.y = blockTop + (badge ? badge.height + badgeHintGap : 0);
        this.body.addChild(hint);
      }
    }

    if (!isOwned) return;

    this.hits.push({
      rect: { x, y, w: cellW, h: cellH },
      fn: () => {
        this.cb.onEquip(equipped ? '' : titleId);
        this.render();
      },
    });
  }
}
