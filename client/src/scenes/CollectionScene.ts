import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { buildIcon } from '../render/icons';
import { cardArtUrl, getArtTexture, preloadL1CardArtTextures } from '../render/cardArt';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawHubTabs, hubTabsHeight, type HubTab } from '../ui/widgets/HubTabs';
import { EQUIP_SLOT } from '../app/equipSlot';
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../game/config';
import { CardType, type CardDefinition } from '../game/types';

// ── CollectionScene — Collection Hub (S3-5 + cards codex) ─────────────────────
//
// Two tabs:
//  • Cards  — read-only codex of every card in the pool (CARD_DEFINITIONS).
//  • Skins  — wardrobe: owned skins + equip; stat-safe (§5.2).
//
// The old "Units" tab (S12 per-unit level + merge) was retired in CC-6: card
// progression now lives in the Hero Roster (CardScene, CHARACTER_CARDS_DESIGN).

export type CollectionTab = 'cards' | 'skins';

export interface CollectionCallbacks {
  onBack(): void;
  /** Owned skin ids (server-authoritative inventory). */
  getSkins(): string[];
  /** Currently equipped skin id, or null for the default look. */
  getEquipped(): string | null;
  /** Equip a skin id, or null to revert to default (writes the equipped segment). */
  equip(skinId: string | null): void;
  /** Which tab to open on (lobby "cards" nav → cards; campaign equip → skins). */
  initialTab?: CollectionTab;
  /**
   * Equipment system (E5) entry point (LOBBY_IA_REDESIGN §3: equipment merged into "progression" top-level reach).
   * Equipment is server-authoritative (upgrade dice roll / charge / inventory) → only available when logged in online;
   * absent / offline: the 4th "Equipment" tab is greyed out and non-tappable.
   * Tap navigates to EquipmentScene (independent scene, back returns here).
   */
  onOpenEquipment?(): void;
}

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

/** One distinct codex entry — cards sharing a name (infantry_1/_2) collapse to one. */
interface CodexEntry {
  card: CardDefinition;
}

export class CollectionScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CollectionCallbacks;
  private tab: CollectionTab;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  /** Art urls whose async-load re-render hook is already attached (fire once each). */
  private readonly artHooked = new Set<string>();

  // ── Scroll state ──────────────────────────────────────────────────────────────
  // Content (cards/skins/units) lives in `layer`, masked to the region below the
  // tabs. Dragging shifts `layer.y`; taps act on pointer-up unless a drag happened.
  private layer!: PIXI.Container;
  private scrollY = 0;
  private maxScroll = 0;
  private regionTop = 0;
  private pointerActive = false;
  private dragging = false;
  private downX = 0;
  private downY = 0;
  private dragStartScroll = 0;

  constructor(layout: ILayout, input: InputManager, cb: CollectionCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.tab = cb.initialTab ?? 'cards';
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    this.render();
    void preloadL1CardArtTextures();
  }

  update(): void { /* static */ }
  destroy(): void { this.unsubs.forEach((u) => u()); }

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
      this.layer.y = -this.scrollY; // cheap re-position; hits stored in content space
    }
  }

  private handleUp(x: number, y: number): void {
    if (!this.pointerActive) return;
    this.pointerActive = false;
    if (this.dragging) { this.dragging = false; return; }
    for (const hit of this.hits) {
      const r = hit.rect;
      // Content hits live in unscrolled content space; chrome hits are screen space.
      if (hit.scroll && y < this.regionTop) continue;
      const py = hit.scroll ? y + this.scrollY : y;
      if (x >= r.x && x <= r.x + r.w && py >= r.y && py <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private select(skinId: string | null): void {
    this.cb.equip(skinId);
    this.render();
  }

  private switchTab(tab: CollectionTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.scrollY = 0; // each tab starts at the top
    this.render();
  }

  /**
   * Draw a card/unit illustration fitted (aspect-kept) into the box at (x,y) of
   * size box×box, added to the scroll layer. Textures load async — if not ready
   * yet, skip this frame and schedule a single re-render once the bitmap arrives
   * (battles usually warm the shared texture cache first, so this is rare).
   */
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

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    tearDownChildren(this.container);
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('collbg', w, h));
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

    const hdr = drawSceneHeader(this.container, w, h, t('collection.title'));
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });

    // Progression group tab bar [Collection|Equipment] (LOBBY_IA_REDESIGN P1.5): Equipment promoted from launcher to peer tab.
    // Only shown when equipment is reachable (logged in online); offline/not logged in degrades to original 3 content tab layout.
    let topY = tbH + Math.round(h * 0.02);
    if (this.cb.onOpenEquipment) {
      const stripH = hubTabsHeight(h);
      this.drawGroupTabs(topY, stripH);
      topY += stripH + Math.round(h * 0.015);
    }

    // Content sub-tab bar (Cards/Skins/Units)
    const tabsY = topY;
    const tabsH = Math.round(h * 0.05);
    const contentY = tabsY + tabsH + Math.round(h * 0.025);
    this.drawTabs(tabsY, tabsH);

    // Masked, scrollable content layer below the tab bar.
    this.regionTop = contentY;
    const clip = new PIXI.Graphics();
    clip.beginFill(0xffffff).drawRect(0, contentY, w, h - contentY).endFill();
    this.container.addChild(clip);
    const layer = new PIXI.Container();
    layer.mask = clip;
    this.container.addChild(layer);
    this.layer = layer;

    const bottom = this.tab === 'cards' ? this.renderCards(contentY)
      : this.renderSkins(contentY);

    const bottomPad = Math.round(h * 0.03);
    this.maxScroll = Math.max(0, bottom + bottomPad - h);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.maxScroll));
    layer.y = -this.scrollY;
  }

  /**
   * Progression group tab bar [Collection|Equipment] (LOBBY_IA_REDESIGN P1.5): Collection active; Equipment tap
   * navigates to EquipmentScene (both ends share the same strip for direct cross-navigation).
   */
  private drawGroupTabs(y: number, stripH: number): void {
    const tabs: HubTab[] = [
      { label: t('collection.title'), active: true },
      { label: t('collection.tab.equipment'), active: false },
    ];
    const hits = drawHubTabs(this.container, this.w, y, stripH, tabs, (i) => {
      if (i === 1) this.cb.onOpenEquipment?.();
    });
    this.hits.push(...hits);
  }

  /** Content sub-tab bar: Cards / Skins (switches the scrollable content). */
  private drawTabs(y: number, hgt: number): void {
    const { w } = this;
    const tabs: Array<{ id: CollectionTab; label: string }> = [
      { id: 'cards', label: t('collection.tab.cards') },
      { id: 'skins', label: t('collection.tab.skins') },
    ];
    const pad = Math.round(w * 0.04);
    const gap = Math.round(w * 0.02);
    const tabW = Math.round((w - pad * 2 - gap * (tabs.length - 1)) / tabs.length);
    tabs.forEach((tabDef, i) => {
      const x = pad + i * (tabW + gap);
      const active = this.tab === tabDef.id;
      const box = sketchPanel(tabW, hgt, {
        fill: active ? C.dark : C.paper,
        border: active ? C.accent : C.line,
        width: active ? 2.4 : 1.6,
        seed: seedFor(x, y, tabW),
      });
      box.x = x; box.y = y;
      this.container.addChild(box);

      const lbl = txt(tabDef.label, Math.round(hgt * 0.42), active ? 0xffffff : C.mid, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + tabW / 2; lbl.y = y + hgt / 2;
      this.container.addChild(lbl);

      if (!active) this.hits.push({ rect: { x, y, w: tabW, h: hgt }, fn: () => this.switchTab(tabDef.id) });
    });
  }

  // ── Cards codex ────────────────────────────────────────────────────────────────

  private renderCards(top: number): number {
    const { w, h } = this;

    // Collapse pool duplicates (infantry_1/_2) to one entry per display name.
    const seen = new Set<string>();
    const entries: CodexEntry[] = [];
    for (const card of CARD_DEFINITIONS) {
      if (seen.has(card.nameKey)) continue;
      seen.add(card.nameKey);
      entries.push({ card });
    }

    const cols = 2;
    const pad = Math.round(w * 0.06);
    const gap = Math.round(w * 0.035);
    const tileW = Math.round((w - pad * 2 - gap * (cols - 1)) / cols);
    const tileH = Math.round(h * 0.155);
    const rowGap = Math.round(h * 0.022);
    let y = top;

    entries.forEach((entry, i) => {
      const col = i % cols;
      const x = pad + col * (tileW + gap);
      if (col === 0 && i > 0) y += tileH + rowGap;
      this.drawCardTile(entry.card, x, y, tileW, tileH);
    });
    return y + tileH;
  }

  /** A read-only codex tile: name + type·cost header, key stats, short blurb. */
  private drawCardTile(card: CardDefinition, x: number, y: number, w: number, h: number): void {
    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    const accent = card.cardType === CardType.Unit ? C.accent
      : card.cardType === CardType.Building ? C.gold : C.red;
    sketchAccentBar(box, h, accent, seedFor(x, h, 6));
    this.layer.addChild(box);

    // Real card illustration (same png as the battle hand) in the header; name +
    // subtitle flow to its right. Falls back to text-only if the card has no art.
    const icSize = Math.round(h * 0.30);
    const icX = x + Math.round(w * 0.07), icY = y + Math.round(h * 0.10);
    const art = cardArtUrl(card);
    if (art) this.drawArtFit(art, icX, icY, icSize);
    const textX = icX + icSize + Math.round(w * 0.04);

    const name = txt(t(card.nameKey as TranslationKey), Math.round(h * 0.15), C.dark, true);
    name.anchor.set(0, 0); name.x = textX; name.y = y + Math.round(h * 0.10);
    this.layer.addChild(name);

    const typeLabel = card.cardType === CardType.Unit ? t('collection.cardType.unit')
      : card.cardType === CardType.Building ? t('collection.cardType.building')
      : t('collection.cardType.spell');
    const sub = txt(`${typeLabel} · ${t('collection.stat.cost')} ${card.cost}`, Math.round(h * 0.12), accent, true);
    sub.anchor.set(0, 0); sub.x = textX; sub.y = y + Math.round(h * 0.32);
    this.layer.addChild(sub);

    const stats = this.cardStatsLine(card);
    if (stats) {
      const st = txt(stats, Math.round(h * 0.115), C.mid);
      st.anchor.set(0, 0); st.x = x + Math.round(w * 0.07); st.y = y + Math.round(h * 0.55);
      // Keep the stat line inside the tile.
      const maxW = w * 0.86;
      if (st.width > maxW) st.scale.set(maxW / st.width);
      this.layer.addChild(st);
    }

    const desc = txt(t(card.descKey as TranslationKey), Math.round(h * 0.10), C.mid);
    desc.anchor.set(0, 0); desc.x = x + Math.round(w * 0.07); desc.y = y + Math.round(h * 0.75);
    const maxDescW = w * 0.86;
    if (desc.width > maxDescW) desc.scale.set(maxDescW / desc.width);
    this.layer.addChild(desc);
  }

  /** Compact stat line from the unit/building blueprint; null for spells. */
  private cardStatsLine(card: CardDefinition): string | null {
    if (card.cardType === CardType.Unit && card.unitType !== undefined) {
      const b = UNIT_BLUEPRINTS[card.unitType];
      return `${t('collection.stat.hp')} ${b.hp} · ${t('collection.stat.atk')} ${b.attack} · ${t('collection.stat.range')} ${b.range}`;
    }
    if (card.cardType === CardType.Building && card.buildingType !== undefined) {
      const b = BUILDING_BLUEPRINTS[card.buildingType];
      const parts = [`${t('collection.stat.hp')} ${b.hp}`];
      if (b.attack !== undefined) {
        parts.push(`${t('collection.stat.atk')} ${b.attack}`);
        if (b.attackRange !== undefined) parts.push(`${t('collection.stat.range')} ${b.attackRange}`);
      }
      return parts.join(' · ');
    }
    return null;
  }

  // ── Skins wardrobe (original) ───────────────────────────────────────────────────

  private renderSkins(top: number): number {
    const { w, h } = this;
    const skins = this.cb.getSkins();
    const equipped = this.cb.getEquipped();

    // Tiles: default look first, then every owned skin.
    const tiles: Array<{ id: string | null; label: string }> = [
      { id: null, label: t('collection.default') },
      ...skins.map((id) => ({ id, label: id })),
    ];

    if (skins.length === 0) {
      const empty = txt(t('collection.empty'), Math.round(h * 0.026), C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = w / 2; empty.y = top + Math.round(h * 0.30);
      this.layer.addChild(empty);
      // The default tile is still shown so the player can confirm the look.
    }

    const cols = 2;
    const pad = Math.round(w * 0.06);
    const gap = Math.round(w * 0.04);
    const tileW = Math.round((w - pad * 2 - gap * (cols - 1)) / cols);
    const tileH = Math.round(h * 0.18);
    let y = top;

    tiles.forEach((tile, i) => {
      const col = i % cols;
      const x = pad + col * (tileW + gap);
      if (col === 0 && i > 0) y += tileH + gap;
      this.drawTile(tile, x, y, tileW, tileH, equipped);
    });
    return y + tileH;
  }

  private drawTile(
    tile: { id: string | null; label: string }, x: number, y: number, w: number, h: number,
    equipped: string | null,
  ): void {
    const isEquipped = tile.id === equipped;
    const box = sketchPanel(w, h, {
      fill: C.paper,
      border: isEquipped ? C.green : C.line,
      width: isEquipped ? 2.6 : 1.6,
      seed: seedFor(x, y, w),
    });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, isEquipped ? C.green : C.accent, seedFor(x, h, 6));
    this.layer.addChild(box);

    // Appearance icon: default look = stationery pencils, owned skin = paintbrush.
    const icSize = Math.round(h * 0.34);
    const ic = buildIcon(tile.id === null ? 'pencils' : 'brush', icSize, isEquipped ? C.green : C.accent);
    ic.x = x + (w - icSize) / 2; ic.y = y + Math.round(h * 0.12);
    this.layer.addChild(ic);

    const name = txt(tile.label, Math.round(h * 0.15), C.dark, true);
    name.anchor.set(0.5, 0.5); name.x = x + w / 2; name.y = y + h * 0.62;
    this.layer.addChild(name);

    const status = txt(isEquipped ? t('collection.equipped') : t('collection.equip'),
      Math.round(h * 0.12), isEquipped ? C.green : C.gold, true);
    status.anchor.set(0.5, 0.5); status.x = x + w / 2; status.y = y + h * 0.84;
    this.layer.addChild(status);

    if (!isEquipped) {
      this.hits.push({ rect: { x, y, w, h }, fn: () => this.select(tile.id), scroll: true });
    }
  }

}

/** The equipped-segment slot key this scene writes (also read by the renderer). */
export { EQUIP_SLOT as COLLECTION_EQUIP_SLOT };
