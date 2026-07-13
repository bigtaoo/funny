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
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;

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

  update(): void { /* static */ }
  destroy(): void {
    this.destroyed = true;
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

  private drawArtFit(url: string, x: number, y: number, box: number): void {
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
    this.layer.addChild(sp);
  }

  private render(): void {
    if (this.destroyed) return;
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
    const tileH = Math.round(h * 0.155);
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

  /** A read-only codex tile: name + type·cost header, key stats, short blurb — greyed + locked if not yet unlocked. */
  private drawCardTile(entry: CodexEntry, x: number, y: number, w: number, h: number): void {
    const { card, locked } = entry;
    const box = sketchPanel(w, h, { fill: locked ? 0xf0efe9 : C.paper, border: locked ? C.mid : C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    const accent = locked ? C.mid
      : card.cardType === CardType.Unit ? C.accent
      : card.cardType === CardType.Building ? C.gold : C.red;
    sketchAccentBar(box, h, accent, seedFor(x, h, 6));
    this.layer.addChild(box);

    const icSize = Math.round(h * 0.30);
    const icX = x + Math.round(w * 0.07), icY = y + Math.round(h * 0.10);
    const art = cardArtUrl(card);
    if (art) this.drawArtFit(art, icX, icY, icSize);
    if (locked) {
      const dim = new PIXI.Graphics();
      dim.beginFill(0xf0efe9, 0.55).drawRect(icX, icY, icSize, icSize).endFill();
      this.layer.addChild(dim);
      const lkSize = Math.round(icSize * 0.4);
      const lk = buildIcon('lock', lkSize, C.mid);
      lk.x = icX + (icSize - lkSize) / 2; lk.y = icY + (icSize - lkSize) / 2;
      this.layer.addChild(lk);
    }
    const textX = icX + icSize + Math.round(w * 0.04);

    const name = txt(t(card.nameKey as TranslationKey), Math.round(h * 0.15), locked ? C.mid : C.dark, true);
    name.anchor.set(0, 0); name.x = textX; name.y = y + Math.round(h * 0.10);
    this.layer.addChild(name);

    const typeLabel = card.cardType === CardType.Unit ? t('collection.cardType.unit')
      : card.cardType === CardType.Building ? t('collection.cardType.building')
      : t('collection.cardType.spell');
    const sub = txt(`${typeLabel} · ${t('collection.stat.cost')} ${card.cost}`, Math.round(h * 0.12), accent, true);
    sub.anchor.set(0, 0); sub.x = textX; sub.y = y + Math.round(h * 0.32);
    this.layer.addChild(sub);

    if (locked) {
      const lockedLbl = txt(t('collection.locked'), Math.round(h * 0.11), C.mid, true);
      lockedLbl.anchor.set(0, 0); lockedLbl.x = x + Math.round(w * 0.07); lockedLbl.y = y + Math.round(h * 0.75);
      this.layer.addChild(lockedLbl);
      return;
    }

    const stats = this.cardStats(card);
    if (stats) {
      this.drawStatChips(stats, x + Math.round(w * 0.07), y + Math.round(h * 0.55), w * 0.86, Math.round(h * 0.14));
    }

    const desc = txt(t(card.descKey as TranslationKey), Math.round(h * 0.10), C.mid);
    desc.anchor.set(0, 0); desc.x = x + Math.round(w * 0.07); desc.y = y + Math.round(h * 0.75);
    const maxDescW = w * 0.86;
    if (desc.width > maxDescW) desc.scale.set(maxDescW / desc.width);
    this.layer.addChild(desc);
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
