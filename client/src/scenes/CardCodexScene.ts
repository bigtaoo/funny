import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { buildIcon, type IconKind } from '../render/icons';
import { cardArtUrl, getArtTexture, preloadL1CardArtTextures } from '../render/cardArt';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawCareerTabs, type CareerNavCallbacks } from '../ui/widgets/CareerTabs';
import { sidebarNavW } from '../ui/widgets/HubTabs';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../game/config';
import { CardType, type CardDefinition } from '../game/types';

// ── CardCodexScene — read-only full card compendium ─────────────────────────────
//
// Folded in from the retired CollectionScene's "Cards" tab (LOBBY_IA_REDESIGN §15): every card in the
// battle pool (CARD_DEFINITIONS), collapsed one entry per display name. Unit cards the player hasn't
// unlocked yet (no owned Hero Roster instance of that character — bridged via `ownedUnitTypes`) render
// greyed out with a lock badge; buildings/spells have no roster-ownership concept and always show
// unlocked. Lives in the Career hub (peer of Stats/Titles/Achievements) since it's a goals/collection
// page, not an operation on the player's own roster (that's CardScene/"Develop").
//
// Tile layout (redesigned 14.07.2026): the illustration fills the full tile height on the left; the
// card's info (name / type·cost / stat chips) sits in its own separately-drawn panel on the right.
// Tapping an unlocked card's illustration plays a squash-flip (borrowed from CardScene/detail.ts's
// flipDetailPortrait) that swaps the art for the card's story text in place; tapping again flips back.
// The flip is driven by PIXI.Ticker.shared, and the per-tile flipped state lives in `flipped` so it
// survives the full re-renders triggered by async art loads / resizes.

export interface CardCodexCallbacks {
  onBack(): void;
  /** UnitTypes with ≥1 owned Hero Roster card instance — drives the locked/unlocked split. */
  getOwnedUnitTypes(): Set<string>;
  onOpenStats?(): void;
  onOpenTitles?(): void;
  onOpenAchievements?(): void;
  hasClaimableAchievement?: boolean;
}

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }
interface CodexEntry { card: CardDefinition; locked: boolean; }

export class CardCodexScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly landscape: boolean;
  private readonly cb: CardCodexCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private readonly artHooked = new Set<string>();
  private destroyed = false;

  private layer!: PIXI.Container;
  private scrollY = 0;
  private maxScroll = 0;
  private regionTop = 0;
  /** Scroll viewport rect + indicator handle (redrawn in the drag fast-path). */
  private scrollView: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private scrollbar: PIXI.Graphics | null = null;
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;
  /** Per-tile flip state (keyed by card.nameKey — the dedup key): art (false) ⇄ story text (true). */
  private readonly flipped = new Set<string>();
  /** Active flip animation cleanups, keyed by the same nameKey, so a re-render can cancel in-flight ticks. */
  private readonly flipCleanups = new Map<string, () => void>();

  constructor(layout: ILayout, input: InputManager, cb: CardCodexCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.landscape = layout.orientation === 'landscape';
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.render();
    void preloadL1CardArtTextures();
  }

  update(): void { /* static — flip animation runs off PIXI.Ticker.shared */ }
  destroy(): void {
    this.destroyed = true;
    this.cancelAllFlips();
    this.unsubs.forEach((u) => u());
    this.container.destroy({ children: true });
  }

  private hasSidebar(): boolean {
    return !!(this.cb.onOpenStats && this.cb.onOpenTitles && this.cb.onOpenAchievements);
  }

  private handleDown(x: number, y: number): void {
    this.pointerActive = true;
    this.dragging = false;
    this.downX = x; this.downY = y;
    this.dragStartScroll = this.scrollY;
  }

  private handleMove(x: number, y: number): void {
    if (!this.pointerActive || this.maxScroll <= 0) return;
    if (!this.dragging && Math.hypot(x - this.downX, y - this.downY) > 8) this.dragging = true;
    if (!this.dragging) return;
    const next = Math.max(0, Math.min(this.dragStartScroll + (this.downY - y), this.maxScroll));
    if (next !== this.scrollY) {
      this.scrollY = next;
      this.layer.y = -this.scrollY;
      if (this.scrollbar) { this.scrollbar.destroy(); this.scrollbar = null; }
      this.scrollbar = drawScrollIndicator(this.container, this.scrollView, this.scrollY, this.maxScroll);
    }
  }

  private handleUp(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (hit.scroll && y < this.regionTop) continue;
      const py = hit.scroll ? y + this.scrollY : y;
      if (x >= r.x && x <= r.x + r.w && py >= r.y && py <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private drawArtFit(url: string, x: number, y: number, box: number, target: PIXI.Container = this.layer): void {
    const tex = getArtTexture(url);
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => this.render());
      }
      return;
    }
    const scale = Math.min(box / tex.width, box / tex.height);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + box / 2, y + box / 2);
    target.addChild(sp);
  }

  private render(): void {
    if (this.destroyed) return;
    // A re-render rebuilds every tile's faceLayer from scratch; cancel any in-flight flip tick first so
    // it can't keep mutating a now-detached container. Settled flip state is preserved in `flipped`.
    this.cancelAllFlips();
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;
    const hasSidebar = this.hasSidebar();

    const railX = this.landscape && hasSidebar ? sidebarNavW(w, h, true) : undefined;
    this.container.addChild(buildPaperBackground('codexbg', w, h, { railX }));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('collection.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    const sidebarW = hasSidebar ? sidebarNavW(w, h, this.landscape) : 0;
    if (hasSidebar) {
      const sidebarTop = tbH + Math.round(h * 0.02);
      const { hits } = drawCareerTabs(this.container, sidebarW, sidebarTop, h, 'codex', {
        onOpenStats: this.cb.onOpenStats!,
        onOpenTitles: this.cb.onOpenTitles!,
        onOpenAchievements: this.cb.onOpenAchievements!,
        onOpenCodex: () => {},
        hasClaimableAchievement: this.cb.hasClaimableAchievement,
      } as CareerNavCallbacks);
      this.hits.push(...hits);
    }

    const contentX = hasSidebar ? sidebarW + Math.round(w * 0.025) : Math.round(w * 0.06);
    const contentTop = tbH + Math.round(h * 0.02);
    this.regionTop = contentTop;
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(contentX, contentTop, w - contentX, h - contentTop).endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);
    this.layer = layer;

    const bottom = this.renderCards(contentX, contentTop, w - contentX - Math.round(w * 0.03));

    const bottomPad = Math.round(h * 0.03);
    this.maxScroll = Math.max(0, bottom + bottomPad - h);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));
    layer.y = -this.scrollY;

    this.scrollView = { x: contentX, y: contentTop, w: w - contentX, h: h - contentTop };
    this.scrollbar = drawScrollIndicator(this.container, this.scrollView, this.scrollY, this.maxScroll);
  }

  // ── Cards codex ────────────────────────────────────────────────────────────────

  private renderCards(left: number, top: number, avail: number): number {
    const { h } = this;
    const owned = this.cb.getOwnedUnitTypes();

    const seen = new Set<string>();
    const entries: CodexEntry[] = [];
    for (const card of CARD_DEFINITIONS) {
      if (seen.has(card.nameKey)) continue;
      seen.add(card.nameKey);
      const locked = card.cardType === CardType.Unit && card.unitType !== undefined && !owned.has(card.unitType);
      entries.push({ card, locked });
    }

    const cols = 2;
    const gap = Math.round(avail * 0.045);
    const tileW = Math.round((avail - gap) / cols);
    const tileH = Math.round(h * 0.19);
    const rowGap = Math.round(h * 0.022);
    let y = top;

    entries.forEach((entry, i) => {
      const col = i % cols;
      const x = left + col * (tileW + gap);
      if (col === 0 && i > 0) y += tileH + rowGap;
      this.drawCardTile(entry, x, y, tileW, tileH);
    });
    return y + tileH;
  }

  /**
   * A read-only codex tile: a full-height illustration on the left (tap-to-flip → story text, when
   * unlocked) and a separate info panel on the right (name + type·cost header, key stats). Locked
   * entries grey out, show a lock over the art, and don't flip.
   */
  private drawCardTile(entry: CodexEntry, x: number, y: number, w: number, h: number): void {
    const { card, locked } = entry;
    const accent = locked ? C.mid
      : card.cardType === CardType.Unit ? C.accent
      : card.cardType === CardType.Building ? C.gold : C.red;

    const key = card.nameKey;
    const art = cardArtUrl(card);
    const story = this.storyText(card);

    // ── Illustration (left, full tile height) ──
    const imgBox = h;
    const frame = sketchPanel(imgBox, h, { fill: locked ? 0xf0efe9 : 0xf7f5ee, border: locked ? C.mid : C.line, width: 1.6, seed: seedFor(x, y, imgBox) });
    frame.x = x; frame.y = y;
    this.layer.addChild(frame);

    const inset = Math.round(imgBox * 0.06);
    const faceBox = imgBox - inset * 2;
    const face = new PIXI.Container();
    face.position.set(x + imgBox / 2, y + h / 2);
    this.layer.addChild(face);
    this.drawTileFace(face, faceBox, card, art, story, !locked && this.flipped.has(key));

    if (locked) {
      const dim = new PIXI.Graphics();
      dim.beginFill(0xf0efe9, 0.55).drawRect(x + inset, y + inset, faceBox, faceBox).endFill();
      this.layer.addChild(dim);
      const lkSize = Math.round(imgBox * 0.28);
      const lk = buildIcon('lock', lkSize, C.mid);
      lk.x = x + (imgBox - lkSize) / 2; lk.y = y + (h - lkSize) / 2;
      this.layer.addChild(lk);
    } else {
      // Tap the illustration to flip between art and the card's story text.
      this.hits.push({
        scroll: true,
        rect: { x, y, w: imgBox, h },
        fn: () => this.flipTile(key, face, faceBox, card, art, story),
      });
    }

    // ── Info panel (right, its own separately-drawn background) ──
    const infoGap = Math.round(w * 0.03);
    const infoX = x + imgBox + infoGap;
    const infoW = w - imgBox - infoGap;
    const info = sketchPanel(infoW, h, { fill: locked ? 0xf0efe9 : C.paper, border: locked ? C.mid : C.line, width: 1.6, seed: seedFor(infoX, y, infoW) });
    info.x = infoX; info.y = y;
    sketchAccentBar(info, h, accent, seedFor(infoX, h, 6));
    this.layer.addChild(info);

    const pad = Math.round(infoW * 0.06);
    const textX = infoX + pad;

    const name = txt(t(card.nameKey as TranslationKey), Math.round(h * 0.15), locked ? C.mid : C.dark, true);
    name.anchor.set(0, 0); name.x = textX; name.y = y + Math.round(h * 0.12);
    this.layer.addChild(name);

    const typeLabel = card.cardType === CardType.Unit ? t('collection.cardType.unit')
      : card.cardType === CardType.Building ? t('collection.cardType.building')
      : t('collection.cardType.spell');
    const sub = txt(`${typeLabel} · ${t('collection.stat.cost')} ${card.cost}`, Math.round(h * 0.12), accent, true);
    sub.anchor.set(0, 0); sub.x = textX; sub.y = y + Math.round(h * 0.34);
    this.layer.addChild(sub);

    if (locked) {
      const lockedLbl = txt(t('collection.locked'), Math.round(h * 0.11), C.mid, true);
      lockedLbl.anchor.set(0, 0); lockedLbl.x = textX; lockedLbl.y = y + Math.round(h * 0.62);
      this.layer.addChild(lockedLbl);
      return;
    }

    const stats = this.cardStats(card);
    if (stats) {
      this.drawStatChips(stats, textX, y + Math.round(h * 0.60), infoW - pad * 2, Math.round(h * 0.15));
    }
  }

  /** The card's story text for the flip's back face: the character lore when it exists, else the card blurb. */
  private storyText(card: CardDefinition): string {
    const loreKey = card.nameKey.replace(/\.name$/, '.lore');
    const lore = t(loreKey as TranslationKey);
    return lore !== loreKey ? lore : t(card.descKey as TranslationKey);
  }

  /** Draw the illustration face: art (front) or word-wrapped story text (back), centred on the container origin. */
  private drawTileFace(container: PIXI.Container, box: number, card: CardDefinition, art: string | null, story: string, showStory: boolean): void {
    container.removeChildren();
    if (!showStory) {
      if (art) { this.drawArtFit(art, -box / 2, -box / 2, box, container); return; }
      // No illustration for this card yet — a faded monogram keeps the frame from reading as broken.
      const initial = t(card.nameKey as TranslationKey).charAt(0).toUpperCase();
      const mono = txt(initial, Math.round(box * 0.5), C.mid, true);
      mono.anchor.set(0.5, 0.5); mono.alpha = 0.35;
      container.addChild(mono);
      return;
    }
    const bg = new PIXI.Graphics();
    bg.beginFill(0xf7f5ee).drawRect(-box / 2, -box / 2, box, box).endFill();
    container.addChild(bg);
    const lore = txt(story, Math.round(box * 0.085), C.mid);
    lore.style.wordWrap = true;
    lore.style.wordWrapWidth = box - 12;
    lore.x = -box / 2 + 6; lore.y = -box / 2 + 6;
    container.addChild(lore);
  }

  /** Squash-flip a tile's illustration (scaleX 1→0→1, swapping art⇄story at the midpoint) via PIXI.Ticker.shared. */
  private flipTile(key: string, container: PIXI.Container, box: number, card: CardDefinition, art: string | null, story: string): void {
    this.cancelFlip(key);
    const DUR_MS = 260;
    let elapsed = 0;
    let swapped = false;
    const tick = (): void => {
      elapsed += PIXI.Ticker.shared.deltaMS;
      const p = Math.min(1, elapsed / DUR_MS);
      if (!swapped && p >= 0.5) {
        swapped = true;
        if (this.flipped.has(key)) this.flipped.delete(key); else this.flipped.add(key);
        this.drawTileFace(container, box, card, art, story, this.flipped.has(key));
      }
      container.scale.x = Math.max(0.02, p < 0.5 ? 1 - p / 0.5 : (p - 0.5) / 0.5);
      if (p >= 1) {
        container.scale.x = 1;
        this.cancelFlip(key);
      }
    };
    this.flipCleanups.set(key, () => PIXI.Ticker.shared.remove(tick));
    PIXI.Ticker.shared.add(tick);
  }

  private cancelFlip(key: string): void {
    const c = this.flipCleanups.get(key);
    if (c) { c(); this.flipCleanups.delete(key); }
  }

  private cancelAllFlips(): void {
    this.flipCleanups.forEach((c) => c());
    this.flipCleanups.clear();
  }

  private cardStats(card: CardDefinition): { icon: IconKind | null; label: string; value: number }[] | null {
    if (card.cardType === CardType.Unit && card.unitType !== undefined) {
      const b = UNIT_BLUEPRINTS[card.unitType];
      return [
        { icon: 'hp', label: t('collection.stat.hp'), value: b.hp },
        { icon: 'atk', label: t('collection.stat.atk'), value: b.attack },
        { icon: null, label: t('collection.stat.range'), value: b.range },
      ];
    }
    if (card.cardType === CardType.Building && card.buildingType !== undefined) {
      const b = BUILDING_BLUEPRINTS[card.buildingType];
      const out: { icon: IconKind | null; label: string; value: number }[] = [
        { icon: 'hp', label: t('collection.stat.hp'), value: b.hp },
      ];
      if (b.attack !== undefined) {
        out.push({ icon: 'atk', label: t('collection.stat.atk'), value: b.attack });
        if (b.attackRange !== undefined) out.push({ icon: null, label: t('collection.stat.range'), value: b.attackRange });
      }
      return out;
    }
    return null;
  }

  private drawStatChips(
    stats: { icon: IconKind | null; label: string; value: number }[],
    x: number, y: number, maxW: number, size: number,
  ): void {
    const row = new PIXI.Container();
    const gap = Math.round(size * 0.28);
    const chipGap = Math.round(size * 0.75);
    const valSize = Math.round(size * 0.74);
    let cx = 0;
    stats.forEach((s, i) => {
      if (i > 0) cx += chipGap;
      if (s.icon) {
        const ic = buildIcon(s.icon, size, C.mid);
        ic.x = cx; ic.y = 0; row.addChild(ic);
        cx += size + gap;
      } else {
        const lbl = txt(s.label, valSize, C.mid);
        lbl.anchor.set(0, 0.5); lbl.x = cx; lbl.y = size / 2; row.addChild(lbl);
        cx += lbl.width + gap;
      }
      const val = txt(String(s.value), valSize, C.dark, true);
      val.anchor.set(0, 0.5); val.x = cx; val.y = size / 2; row.addChild(val);
      cx += val.width;
    });
    row.x = x; row.y = y;
    if (row.width > maxW) row.scale.set(maxW / row.width);
    this.layer.addChild(row);
  }
}
