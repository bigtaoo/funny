import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import { sortTitlesByWeight, getTitleKeys, formatLadderTitle } from '../game/meta/titles';

// ── TitlesScene — 称号墙（S10，TITLE_DESIGN §7）────────────────────────────────
//
// 入口：SettingsScene → onOpenTitles。
// 显示：玩家拥有的所有称号，按 weight 降序排列；已佩戴的高亮显示。
// 交互：点击称号条目 → 更新 equipped['title']（PUT /save，客户端同步段）。

export interface TitlesSceneCallbacks {
  onBack(): void;
  /** 玩家拥有的称号 id 列表（来自 save.titles）。 */
  titles: string[];
  /** 当前佩戴的称号 id（save.equipped['title']）。 */
  equippedTitle: string;
  /** 佩戴新称号 → 写入 equipped['title'] + PUT /save。 */
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
    this.container.removeChildren();
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
    this.container.removeChildren();
    this.hits = [];

    this.drawBackground();
    this.drawHeader();
    this.drawTitleList();
  }

  private drawBackground(): void {
    const { w, h } = this;
    const bg = buildPaperBackground('titlesbg', w, h);
    this.container.addChild(bg);
  }

  private drawHeader(): void {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);
    const bar = new PIXI.Graphics();
    bar.beginFill(0x2c2c2a); bar.drawRect(0, 0, w, tbH); bar.endFill();
    this.container.addChild(bar);

    const title = txt(t('titles.title'), Math.round(h * 0.042), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('titles.back'), Math.round(h * 0.026), 0xdddddd);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    const pad = Math.round(h * 0.018);
    this.hits.push({
      rect: { x: back.x - pad, y: back.y - back.height / 2 - pad, w: back.width + 2 * pad, h: back.height + 2 * pad },
      fn: () => this.cb.onBack(),
    });
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

      const nameLbl = txt(`「${shortLabel}」  ${fullLabel}`, Math.round(rowH * 0.38), equipped ? C.gold : C.dark, equipped);
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
