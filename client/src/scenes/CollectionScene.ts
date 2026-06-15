import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { EQUIP_SLOT } from '../app/equipSlot';
import { CARD_DEFINITIONS, UNIT_BLUEPRINTS, BUILDING_BLUEPRINTS } from '../game/config';
import { CardType, type CardDefinition } from '../game/types';

// ── CollectionScene — 收藏中心 (S3-5 + cards codex) ─────────────────────────────
//
// Two tabs:
//  • Cards  — read-only codex of every card in the pool (CARD_DEFINITIONS), with
//             its cost + combat stats pulled from the unit/building blueprints.
//             Pure client data; nothing is owned/unlocked here (every card is in
//             the random pool), it is purely a "what does this card do" reference.
//  • Skins  — the original wardrobe: lists owned skins (inventory.skins, server-
//             authoritative read-only) plus a "default look" tile. Tapping a tile
//             equips it; the choice lives in the client-sync `equipped` segment.
//             Rendering swaps texture only (S3-4) — never stats (§5.2).


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
}

interface Hit { rect: Rect; fn: () => void; }

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

  constructor(layout: ILayout, input: InputManager, cb: CollectionCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.tab = cb.initialTab ?? 'cards';
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
  }

  update(): void { /* static */ }
  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private select(skinId: string | null): void {
    this.cb.equip(skinId);
    this.render();
  }

  private switchTab(tab: CollectionTab): void {
    if (this.tab === tab) return;
    this.tab = tab;
    this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  private render(): void {
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('collbg', w, h));

    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('collection.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('collection.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: () => this.cb.onBack() });

    // Tab bar
    const tabsY = tbH + Math.round(h * 0.02);
    const tabsH = Math.round(h * 0.05);
    const contentY = tabsY + tabsH + Math.round(h * 0.025);
    this.drawTabs(tabsY, tabsH);

    if (this.tab === 'cards') this.renderCards(contentY);
    else this.renderSkins(contentY);
  }

  private drawTabs(y: number, hgt: number): void {
    const { w } = this;
    const tabs: Array<{ id: CollectionTab; label: string }> = [
      { id: 'cards', label: t('collection.tab.cards') },
      { id: 'skins', label: t('collection.tab.skins') },
    ];
    const pad = Math.round(w * 0.06);
    const gap = Math.round(w * 0.03);
    const tabW = Math.round((w - pad * 2 - gap) / 2);
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

  private renderCards(top: number): void {
    const { w, h } = this;

    // Collapse pool duplicates (infantry_1/_2) to one entry per display name.
    const seen = new Set<TranslationKey>();
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
  }

  /** A read-only codex tile: name + type·cost header, key stats, short blurb. */
  private drawCardTile(card: CardDefinition, x: number, y: number, w: number, h: number): void {
    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    const accent = card.cardType === CardType.Unit ? C.accent
      : card.cardType === CardType.Building ? C.gold : C.red;
    sketchAccentBar(box, h, accent, seedFor(x, h, 6));
    this.container.addChild(box);

    const name = txt(t(card.nameKey), Math.round(h * 0.15), C.dark, true);
    name.anchor.set(0, 0); name.x = x + Math.round(w * 0.07); name.y = y + Math.round(h * 0.10);
    this.container.addChild(name);

    const typeLabel = card.cardType === CardType.Unit ? t('collection.cardType.unit')
      : card.cardType === CardType.Building ? t('collection.cardType.building')
      : t('collection.cardType.spell');
    const sub = txt(`${typeLabel} · ${t('collection.stat.cost')} ${card.cost}`, Math.round(h * 0.12), accent, true);
    sub.anchor.set(0, 0); sub.x = x + Math.round(w * 0.07); sub.y = y + Math.round(h * 0.32);
    this.container.addChild(sub);

    const stats = this.cardStatsLine(card);
    if (stats) {
      const st = txt(stats, Math.round(h * 0.115), C.mid);
      st.anchor.set(0, 0); st.x = x + Math.round(w * 0.07); st.y = y + Math.round(h * 0.55);
      // Keep the stat line inside the tile.
      const maxW = w * 0.86;
      if (st.width > maxW) st.scale.set(maxW / st.width);
      this.container.addChild(st);
    }

    const desc = txt(t(card.descKey), Math.round(h * 0.10), C.mid);
    desc.anchor.set(0, 0); desc.x = x + Math.round(w * 0.07); desc.y = y + Math.round(h * 0.75);
    const maxDescW = w * 0.86;
    if (desc.width > maxDescW) desc.scale.set(maxDescW / desc.width);
    this.container.addChild(desc);
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

  private renderSkins(top: number): void {
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
      this.container.addChild(empty);
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
    this.container.addChild(box);

    const name = txt(tile.label, Math.round(h * 0.16), C.dark, true);
    name.anchor.set(0.5, 0.5); name.x = x + w / 2; name.y = y + h * 0.4;
    this.container.addChild(name);

    const status = txt(isEquipped ? t('collection.equipped') : t('collection.equip'),
      Math.round(h * 0.13), isEquipped ? C.green : C.gold, true);
    status.anchor.set(0.5, 0.5); status.x = x + w / 2; status.y = y + h * 0.74;
    this.container.addChild(status);

    if (!isEquipped) {
      this.hits.push({ rect: { x, y, w, h }, fn: () => this.select(tile.id) });
    }
  }
}

/** The equipped-segment slot key this scene writes (also read by the renderer). */
export { EQUIP_SLOT as COLLECTION_EQUIP_SLOT };
