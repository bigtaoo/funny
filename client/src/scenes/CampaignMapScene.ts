import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { CAMPAIGN_LEVEL_ORDER } from '../game';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';

// ── CampaignMapScene (S3-5) — PvE level select hub ─────────────────────────────
//
// Canvas-drawn, render()-on-change + flat hit-list (mirrors ShopScene). Lists the
// campaign levels with their earned stars; a level is locked until the previous
// one is cleared (sequential gate). Tapping an unlocked level opens LevelPrepScene
// (upgrades + start). A "collection" entry reaches the wardrobe.

export interface CampaignMapCallbacks {
  onBack(): void;
  /** Open the prep screen for a level id. */
  onSelectLevel(levelId: string): void;
  /** Open the collection (wardrobe) scene. */
  onOpenCollection(): void;
  /** Stars earned per level id (0..3); absent = 0. */
  getStars(): Record<string, 1 | 2 | 3>;
  /** Cleared level ids — drives the sequential unlock gate. */
  getCleared(): string[];
}

interface Hit { rect: Rect; fn: () => void; }

export class CampaignMapScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CampaignMapCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  constructor(layout: ILayout, input: InputManager, cb: CampaignMapCallbacks) {
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

  /** A level unlocks once the previous one in the order is cleared (level 0 free). */
  private isUnlocked(index: number, cleared: Set<string>): boolean {
    if (index === 0) return true;
    return cleared.has(CAMPAIGN_LEVEL_ORDER[index - 1]);
  }

  private render(): void {
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;

    this.container.addChild(buildPaperBackground('campbg', w, h));

    // Header.
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('campaign.title'), Math.round(h * 0.034), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('campaign.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: () => this.cb.onBack() });

    // Collection entry (top-right).
    const coll = txt(t('campaign.collection'), Math.round(h * 0.024), C.gold, true);
    coll.anchor.set(1, 0.5); coll.x = w - Math.round(w * 0.04); coll.y = tbH / 2;
    this.container.addChild(coll);
    this.hits.push({
      rect: { x: coll.x - coll.width - Math.round(w * 0.03), y: 0, w: coll.width + Math.round(w * 0.06), h: tbH },
      fn: () => this.cb.onOpenCollection(),
    });

    // Level list.
    const stars = this.cb.getStars();
    const cleared = new Set(this.cb.getCleared());
    const listX = Math.round(w * 0.08);
    const listW = w - listX * 2;
    const rowH = Math.round(h * 0.11);
    const gap = Math.round(h * 0.02);
    let y = tbH + Math.round(h * 0.05);

    CAMPAIGN_LEVEL_ORDER.forEach((levelId, i) => {
      this.drawLevelRow(levelId, i, this.isUnlocked(i, cleared), stars[levelId] ?? 0, listX, y, listW, rowH);
      y += rowH + gap;
    });
  }

  private drawLevelRow(
    levelId: string, index: number, unlocked: boolean, starCount: number,
    x: number, y: number, w: number, h: number,
  ): void {
    const box = sketchPanel(w, h, {
      fill: unlocked ? C.paper : C.btnDis,
      border: unlocked ? C.gold : C.btnOff,
      width: 2, seed: seedFor(x, y, w), fillAlpha: unlocked ? 1 : 0.85,
    });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, unlocked ? C.accent : C.btnOff, seedFor(x, h, 4));
    this.container.addChild(box);

    const name = txt(t('campaign.levelLabel', { n: index + 1 }), Math.round(h * 0.28),
      unlocked ? C.dark : C.mid, true);
    name.anchor.set(0, 0.5); name.x = x + Math.round(w * 0.05); name.y = y + h * 0.38;
    this.container.addChild(name);

    // Stars row (★ filled / ☆ empty) or lock label.
    if (unlocked) {
      const starStr = '★'.repeat(starCount) + '☆'.repeat(3 - starCount);
      const st = txt(starStr, Math.round(h * 0.24), C.gold);
      st.anchor.set(0, 0.5); st.x = x + Math.round(w * 0.05); st.y = y + h * 0.72;
      this.container.addChild(st);
    } else {
      const lock = txt(t('campaign.locked'), Math.round(h * 0.20), C.mid);
      lock.anchor.set(0, 0.5); lock.x = x + Math.round(w * 0.05); lock.y = y + h * 0.72;
      this.container.addChild(lock);
    }

    if (unlocked) {
      this.hits.push({ rect: { x, y, w, h }, fn: () => this.cb.onSelectLevel(levelId) });
    }
  }
}
