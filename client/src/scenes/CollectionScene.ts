import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { EQUIP_SLOT } from '../app/equipSlot';

// ── CollectionScene (S3-5) — skin wardrobe (收集) ──────────────────────────────
//
// Lists owned skins (inventory.skins, server-authoritative read-only) plus a
// "default look" tile. Tapping a tile equips it; the equipped choice lives in the
// client-sync `equipped` segment. Rendering swaps texture only (S3-4) — never
// stats — so a skin carried into PvP changes nothing but the picture (§5.2).


export interface CollectionCallbacks {
  onBack(): void;
  /** Owned skin ids (server-authoritative inventory). */
  getSkins(): string[];
  /** Currently equipped skin id, or null for the default look. */
  getEquipped(): string | null;
  /** Equip a skin id, or null to revert to default (writes the equipped segment). */
  equip(skinId: string | null): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class CollectionScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CollectionCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: CollectionCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
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

    const skins = this.cb.getSkins();
    const equipped = this.cb.getEquipped();

    // Tiles: default look first, then every owned skin.
    const tiles: Array<{ id: string | null; label: string }> = [
      { id: null, label: t('collection.default') },
      ...skins.map((id) => ({ id, label: id })),
    ];

    if (skins.length === 0) {
      const empty = txt(t('collection.empty'), Math.round(h * 0.026), C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = w / 2; empty.y = tbH + Math.round(h * 0.30);
      this.container.addChild(empty);
      // The default tile is still shown so the player can confirm the look.
    }

    const cols = 2;
    const pad = Math.round(w * 0.06);
    const gap = Math.round(w * 0.04);
    const tileW = Math.round((w - pad * 2 - gap * (cols - 1)) / cols);
    const tileH = Math.round(h * 0.18);
    let y = tbH + Math.round(h * 0.05);

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
