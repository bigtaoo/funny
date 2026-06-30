import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { sortTitlesByWeight, getTitleKeys, formatLadderTitle } from '../game/meta/titles';

// â”€â”€ TitlesScene â€” title wall (S10, TITLE_DESIGN Â§7) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Entry: StatsScene â†’ onOpenTitles.
// Displays: all titles owned by the player, sorted by weight descending; the equipped one is highlighted.
// Interaction: tap a title row â†’ update equipped['title'] (PUT /save, client-side sync segment).

export interface TitlesSceneCallbacks {
  onBack(): void;
  /** List of title ids owned by the player (from save.titles). */
  titles: string[];
  /** Currently equipped title id (save.equipped['title']). */
  equippedTitle: string;
  /** Equip a new title â†’ write equipped['title'] + PUT /save. */
  onEquip(titleId: string): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class TitlesScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: TitlesSceneCallbacks;

  private hits: Hit[] = [];

  constructor(layout: ILayout, input: InputManager, cb: TitlesSceneCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;

    input.onDown((x, y) => this.handleDown(x, y));
    this.render();
  }

  update(_dt: number): void {}

  destroy(): void {
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
    this.drawHeader();
    this.drawTitleList();
  }

  private drawBackground(): void {
    const { w, h } = this;
    const bg = buildPaperBackground('titlesbg', w, h);
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);
  }

  private drawHeader(): void {
    const { w, h } = this;
    const hdr = drawSceneHeader(this.container, w, h, t('titles.title'), { titleSize: Math.round(h * 0.042) });
    const tbH = hdr.headerH;
    this.hits.push({ rect: hdr.backRect, fn: () => this.cb.onBack() });
  }

  private drawTitleList(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const padX = Math.round(w * 0.08);
    const rowH = Math.round(h * 0.1);
    const gap = Math.round(h * 0.016);
    const rowW = w - 2 * padX;
    const sorted = sortTitlesByWeight(this.cb.titles);

    if (sorted.length === 0) {
      const empty = txt(t('titles.empty'), Math.round(h * 0.032), C.mid);
      empty.anchor.set(0.5, 0.5); empty.x = w / 2; empty.y = h / 2;
      this.container.addChild(empty);
      return;
    }

    sorted.forEach((titleId, i) => {
      const rowY = tbH + Math.round(h * 0.04) + i * (rowH + gap);
      const equipped = titleId === this.cb.equippedTitle;

      const row = sketchPanel(rowW, rowH, {
        fill: equipped ? 0xfef8e0 : C.paper,
        border: equipped ? C.gold : C.line,
        width: equipped ? 2.5 : 1.5,
        seed: seedFor(padX, rowY + i, rowW),
      });
      row.x = padX; row.y = rowY;
      this.container.addChild(row);

      const keys = getTitleKeys(titleId);
      const shortLabel = keys
        ? (t(keys.shortKey as import('../i18n').TranslationKey) || formatLadderTitle(titleId))
        : formatLadderTitle(titleId);
      const fullLabel = keys
        ? (t(keys.fullKey as import('../i18n').TranslationKey) || shortLabel)
        : shortLabel;

      const nameLbl = txt(`ã€Œ${shortLabel}ã€  ${fullLabel}`, Math.round(rowH * 0.38), equipped ? C.gold : C.dark, equipped);
      nameLbl.anchor.set(0, 0.5); nameLbl.x = padX + Math.round(rowW * 0.04); nameLbl.y = rowY + rowH / 2;
      this.container.addChild(nameLbl);

      if (equipped) {
        const badge = txt(t('titles.equipped'), Math.round(rowH * 0.3), C.gold, true);
        badge.anchor.set(1, 0.5); badge.x = padX + rowW - Math.round(rowW * 0.04); badge.y = rowY + rowH / 2;
        this.container.addChild(badge);
      } else {
        this.hits.push({
          rect: { x: padX, y: rowY, w: rowW, h: rowH },
          fn: () => {
            this.cb.onEquip(titleId);
            this.render();
          },
        });
      }
    });
  }
}
