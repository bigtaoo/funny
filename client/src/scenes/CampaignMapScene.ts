import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { CAMPAIGN_LEVEL_ORDER, CAMPAIGN_LEVELS } from '../game';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';

// ── CampaignMapScene (S3-5) — PvE level select hub ─────────────────────────────
//
// Canvas-drawn, render()-on-change. Levels grouped by chapter with a scrollable list.
// Drag-scroll (≥8 px threshold distinguishes tap from drag). nameKey from level JSON
// shown as subtitle when supplied by story author. Mirrors FriendsScene drag pattern.

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
  /** Online = can reach /pve/* (clear/unlock are server-authoritative, §8). Offline gates new unlocks. */
  isOnline(): boolean;
  /** Level ids with an offline clear queued for settlement (shown as「待结算」). */
  getPendingLevels(): string[];
}

interface Hit { rect: Rect; fn: () => void; scroll?: boolean; }

interface ChapterGroup { chapter: number; levelIds: string[]; }

/** Parse chapter number and within-chapter index from a level id like 'ch3_lv7'. */
function parseLevelId(id: string): { chapter: number; lvIndex: number } | null {
  const m = id.match(/^ch(\d+)_lv(\d+)$/);
  if (!m) return null;
  return { chapter: parseInt(m[1], 10), lvIndex: parseInt(m[2], 10) };
}

function groupByChapter(levelIds: readonly string[]): ChapterGroup[] {
  const map = new Map<number, string[]>();
  for (const id of levelIds) {
    const p = parseLevelId(id);
    const ch = p?.chapter ?? 0;
    if (!map.has(ch)) map.set(ch, []);
    map.get(ch)!.push(id);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a - b)
    .map(([chapter, ids]) => ({ chapter, levelIds: ids }));
}

export class CampaignMapScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CampaignMapCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];

  // Scroll state
  private scrollY = 0;
  private maxScroll = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;
  private hasDragged = false;

  // List geometry — set during render, used for hit-testing
  private listY = 0;
  private listH = 0;
  private readonly listContainer: PIXI.Container;

  constructor(layout: ILayout, input: InputManager, cb: CampaignMapCallbacks) {
    this.container = new PIXI.Container();
    this.listContainer = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));

    this.render();
  }

  update(): void { /* static */ }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    this.dragStart = { x, y, scroll: this.scrollY };
    this.hasDragged = false;
  }

  private handleMove(_x: number, y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (!this.hasDragged && Math.abs(dy) < 8) return;
    this.hasDragged = true;
    this.scrollY = Math.max(0, Math.min(this.maxScroll, this.dragStart.scroll - dy));
    this.listContainer.y = this.listY - this.scrollY;
  }

  private handleUp(x: number, y: number): void {
    if (!this.dragStart) return;
    if (!this.hasDragged) {
      // Treat as tap — test fixed hits first, then scrollable list hits.
      for (const hit of this.hits) {
        const r = hit.rect;
        if (hit.scroll) {
          // Translate tap into content space; only fire if within list viewport.
          if (x < r.x || x > r.x + r.w) continue;
          const contentY = y - this.listY + this.scrollY;
          if (contentY >= r.y && contentY <= r.y + r.h) { hit.fn(); break; }
        } else {
          if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); break; }
        }
      }
    }
    this.dragStart = null;
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

    // ── Header (fixed) ──────────────────────────────────────────────────────
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

    const coll = txt(t('campaign.collection'), Math.round(h * 0.024), C.gold, true);
    coll.anchor.set(1, 0.5); coll.x = w - Math.round(w * 0.04); coll.y = tbH / 2;
    this.container.addChild(coll);
    this.hits.push({
      rect: { x: coll.x - coll.width - Math.round(w * 0.03), y: 0, w: coll.width + Math.round(w * 0.06), h: tbH },
      fn: () => this.cb.onOpenCollection(),
    });

    // ── Scrollable list ─────────────────────────────────────────────────────
    this.listY = tbH + Math.round(h * 0.02);
    this.listH = h - this.listY - Math.round(h * 0.02);

    // Mask clips the list to its viewport.
    const mask = new PIXI.Graphics();
    mask.beginFill(0xffffff); mask.drawRect(0, this.listY, w, this.listH); mask.endFill();
    this.container.addChild(mask);

    this.listContainer.removeChildren();
    this.listContainer.y = this.listY;
    this.listContainer.mask = mask;
    this.container.addChild(this.listContainer);

    const stars = this.cb.getStars();
    const cleared = new Set(this.cb.getCleared());
    const online = this.cb.isOnline();
    const pending = new Set(this.cb.getPendingLevels());
    const globalOrder = CAMPAIGN_LEVEL_ORDER;

    const listX    = Math.round(w * 0.05);
    const listW    = w - listX * 2;
    const rowH     = Math.round(h * 0.095);
    const rowGap   = Math.round(h * 0.016);
    const chHdrH   = Math.round(h * 0.065);
    const chHdrGap = Math.round(h * 0.01);

    const chapters = groupByChapter(CAMPAIGN_LEVEL_ORDER);
    let cy = 0; // y offset within listContainer content

    for (const { chapter, levelIds } of chapters) {
      // Chapter header row
      const chLabel = txt(t('campaign.chapterLabel', { n: chapter }), Math.round(chHdrH * 0.52), C.accent, true);
      chLabel.anchor.set(0, 0.5);
      chLabel.x = listX;
      chLabel.y = cy + chHdrH / 2;
      this.listContainer.addChild(chLabel);

      // Decorative line after chapter label
      const chLine = new PIXI.Graphics();
      const lx = listX + chLabel.width + Math.round(w * 0.025);
      const ly = Math.round(cy + chHdrH / 2);
      chLine.lineStyle(1, C.accent, 0.35);
      chLine.moveTo(lx, ly); chLine.lineTo(w - listX, ly);
      chLine.lineStyle(0);
      this.listContainer.addChild(chLine);

      cy += chHdrH + chHdrGap;

      for (const levelId of levelIds) {
        const globalIndex = globalOrder.indexOf(levelId);
        const parsed = parseLevelId(levelId);
        const lvIndex = parsed?.lvIndex ?? (globalIndex + 1);
        const unlocked = this.isUnlocked(globalIndex, cleared);
        const starCount = stars[levelId] ?? 0;
        const isPending = pending.has(levelId);

        this.drawLevelRow(
          levelId, lvIndex, chapter, unlocked, starCount, online, isPending,
          listX, cy, listW, rowH,
        );
        cy += rowH + rowGap;
      }

      cy += Math.round(h * 0.015); // extra gap between chapters
    }

    this.maxScroll = Math.max(0, cy - this.listH);
    // Clamp existing scrollY after a re-render (e.g. resize).
    this.scrollY = Math.min(this.scrollY, this.maxScroll);
    this.listContainer.y = this.listY - this.scrollY;
  }

  private drawLevelRow(
    levelId: string, lvIndex: number, _chapter: number,
    unlocked: boolean, starCount: number,
    online: boolean, pending: boolean,
    x: number, y: number, w: number, h: number,
  ): void {
    const box = sketchPanel(w, h, {
      fill: unlocked ? C.paper : C.btnDis,
      border: unlocked ? C.gold : C.btnOff,
      width: 2, seed: seedFor(x, y, w), fillAlpha: unlocked ? 1 : 0.85,
    });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, unlocked ? C.accent : C.btnOff, seedFor(x, h, 4));
    this.listContainer.addChild(box);

    // Level label (within-chapter index)
    const nameStr = t('campaign.levelLabel', { n: lvIndex });
    const hasNameKey = !!(CAMPAIGN_LEVELS[levelId]?.nameKey);
    const labelFontSz = hasNameKey ? Math.round(h * 0.25) : Math.round(h * 0.30);
    const labelY = hasNameKey ? h * 0.32 : h * 0.50;

    const name = txt(nameStr, labelFontSz, unlocked ? C.dark : C.mid, true);
    name.anchor.set(0, 0.5); name.x = x + Math.round(w * 0.05); name.y = y + labelY;
    this.listContainer.addChild(name);

    // Optional story name (nameKey)
    if (hasNameKey) {
      const story = txt(t(CAMPAIGN_LEVELS[levelId]!.nameKey!), Math.round(h * 0.21), unlocked ? C.dark : C.mid);
      story.anchor.set(0, 0.5); story.x = x + Math.round(w * 0.05); story.y = y + h * 0.70;
      this.listContainer.addChild(story);
    }

    // Stars / pending / lock on the right
    if (unlocked) {
      const starStr = '★'.repeat(starCount) + '☆'.repeat(3 - starCount);
      const st = txt(starStr, Math.round(h * 0.26), C.gold);
      st.anchor.set(1, 0.5); st.x = x + w - Math.round(w * 0.05); st.y = y + h * 0.50;
      this.listContainer.addChild(st);
      if (pending) {
        const pd = txt(t('campaign.pending'), Math.round(h * 0.18), C.mid);
        pd.anchor.set(1, 0.5); pd.x = x + w - Math.round(w * 0.05); pd.y = y + h * 0.78;
        this.listContainer.addChild(pd);
      }
    } else {
      const lockKey = online ? 'campaign.locked' : 'campaign.lockedOffline';
      const lock = txt(t(lockKey), Math.round(h * 0.20), C.mid);
      lock.anchor.set(1, 0.5); lock.x = x + w - Math.round(w * 0.05); lock.y = y + h * 0.50;
      this.listContainer.addChild(lock);
    }

    if (unlocked) {
      // Hit rect is in content space (relative to listContainer origin = listY).
      // handleUp will offset by scrollY before comparing.
      this.hits.push({ rect: { x, y, w, h }, scroll: true, fn: () => this.cb.onSelectLevel(levelId) });
    }
  }
}
