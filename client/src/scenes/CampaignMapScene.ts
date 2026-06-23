import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { CHAPTER_ORDER, getChapterMap } from '../game';
import type { ChapterMap, ChapterNode } from '../game';
import { parseLevelId, isLevelUnlocked, currentChapter, currentLevelIdInChapter } from '../game/campaign/progress';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import { SketchPen } from '../render/sketch';
import { palette } from '../render/theme';

// ── CampaignMapScene (S3-5 → CAMPAIGN_DESIGN §12) — the「战役笔记本」─────────────
//
// The PvE entry is a diegetic open notebook, not a flat list. Two page kinds:
//   • TOC (landing): one card per chapter with venue name + star progress + lock
//     state; tapping an unlocked chapter flips to its page.
//   • Chapter page: that chapter's 10 levels drawn as hand-placed nodes threaded
//     by a pencil trail (positions from `maps/chN.json`, normalized 0..1). Cleared
//     nodes get a star stamp, the current playable node pulses, locked nodes are a
//     faint pencil outline. Procedural doodle decor (start/boss/rack…) sets venue.
//
// On entry the book "opens" — it starts on the TOC then auto-flips to the chapter
// holding the current playable level (progress landing, §12.2). Page changes are a
// horizontal slide+fade ("page turn") driven from update(); the current node's
// pulse is animated there too. All art is procedural (SketchPen + sketchUi), no
// assets. Callbacks/interface are unchanged so app wiring + ui tests keep working.

export interface CampaignMapCallbacks {
  onBack(): void;
  /** Open the prep screen for a level id. */
  onSelectLevel(levelId: string): void;
  /** Open the collection (wardrobe) scene. */
  onOpenCollection(): void;
  /** Open the equipment scene (E5). Absent when offline (server-authoritative). */
  onOpenEquipment?(): void;
  /** Stars earned per level id (0..3); absent = 0. */
  getStars(): Record<string, 1 | 2 | 3>;
  /** Cleared level ids — drives the sequential unlock gate. */
  getCleared(): string[];
  /** Online = can reach /pve/* (clear/unlock are server-authoritative, §8). Offline gates new unlocks. */
  isOnline(): boolean;
  /** Level ids with an offline clear queued for settlement (shown as「待结算」). */
  getPendingLevels(): string[];
}

interface Hit { rect: Rect; fn: () => void; }

/** A built page: its display root, tap targets, and (optionally) the node to pulse. */
interface Page {
  root: PIXI.Container;
  hits: Hit[];
  pulse: PIXI.Graphics | null;
}

/** Flip transition between two pages. */
interface Flip {
  out: PIXI.Container;
  in: PIXI.Container;
  t: number;
  dir: 1 | -1; // +1 forward (new slides in from right), -1 backward
}

const FLIP_DUR = 0.42; // seconds

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

export class CampaignMapScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: CampaignMapCallbacks;
  private readonly unsubs: Array<() => void> = [];

  /** Currently shown page kind + chapter. */
  private mode: 'toc' | 'chapter' = 'toc';
  private chapter = CHAPTER_ORDER[0]!;

  private page: Page | null = null;
  private flip: Flip | null = null;

  private hits: Hit[] = [];
  private pulseT = 0;

  // No scroll — every page fits one screen by construction.

  constructor(layout: ILayout, input: InputManager, cb: CampaignMapCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;

    this.container.addChild(buildPaperBackground('campbg', this.w, this.h));

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));

    // Land DIRECTLY on the current chapter (progress landing, §12.2).
    //
    // This used to open on the TOC and auto-flip to the chapter — a cosmetic
    // "book opening". But that gated EVERY tap target behind the opening flip:
    // during a flip `this.hits = []` and `handleDown` is a no-op, and the flip
    // only settles from `update()`. If the ticker stalled for any reason the
    // scene rendered but was completely dead — no level select, no way back —
    // which is exactly the recurring「无法选择关卡/回不去大厅」bug. Building the
    // chapter page as the initial page keeps hits live from the first frame,
    // independent of update()/ticker timing. (Tab-to-tab page turns still flip.)
    this.chapter = currentChapter(new Set(this.cb.getCleared()));
    this.mode = 'chapter';
    this.showPage(this.buildChapter(this.chapter));
  }

  update(dt: number): void {
    this.pulseT += dt;
    const ring = this.page?.pulse;
    if (ring) {
      const k = 0.5 + 0.5 * Math.sin(this.pulseT * 4.2);
      ring.scale.set(1 + 0.22 * k);
      ring.alpha = 0.3 + 0.45 * k;
    }
    if (this.flip) this.advanceFlip(dt);
  }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  // ── Page lifecycle ────────────────────────────────────────────────────────────

  private showPage(p: Page): void {
    if (this.page) { this.container.removeChild(this.page.root); this.page.root.destroy({ children: true }); }
    this.page = p;
    this.hits = p.hits;
    this.container.addChild(p.root);
  }

  /** Start a slide+fade flip to a freshly built page. `dir` +1 = forward. */
  private flipTo(build: () => Page, dir: 1 | -1, onArrive?: () => void): void {
    if (this.flip || !this.page) return;
    const neu = build();
    const out = this.page.root;
    // The incoming page becomes the live one immediately — its hits take over NOW,
    // not after the flip settles. Keeping hits live mid-flip means a tap still works
    // even if the ticker stalls before `update()` finishes the animation. Re-entrant
    // flips are already prevented by the `this.flip` guards in flipTo/openChapter/
    // backToToc, so unguarded hits here can't stack a second flip.
    this.page = neu;
    this.hits = neu.hits;
    this.container.addChild(neu.root);
    neu.root.x = dir * this.w;
    neu.root.alpha = 0;
    this.flip = { out, in: neu.root, t: 0, dir };
    this.arrive = onArrive ?? null;
  }

  private arrive: (() => void) | null = null;

  private advanceFlip(dt: number): void {
    const f = this.flip!;
    f.t = Math.min(1, f.t + dt / FLIP_DUR);
    const e = easeInOut(f.t);
    f.out.x = -f.dir * this.w * e;
    f.out.alpha = 1 - e;
    f.in.x = f.dir * this.w * (1 - e);
    f.in.alpha = e;
    if (f.t >= 1) {
      this.container.removeChild(f.out);
      f.out.destroy({ children: true });
      f.in.x = 0; f.in.alpha = 1;
      this.flip = null;
      this.hits = this.page!.hits;
      const cb = this.arrive; this.arrive = null;
      if (cb) cb();
    }
  }

  private handleDown(x: number, y: number): void {
    // No `this.flip` guard: hits are kept live across flips (see flipTo), so taps
    // work even mid-animation or if the ticker stalls before a flip settles.
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); break; }
    }
  }

  // ── Shared header ───────────────────────────────────────────────────────────

  /** Draws the fixed top band into `root`; returns its height. Pushes its hits. */
  private buildHeader(root: PIXI.Container, hits: Hit[], titleStr: string, onBack: () => void, subtitleStr?: string): number {
    const { w, h } = this;
    const tbH = Math.round(h * 0.12);

    const bar = new PIXI.Graphics();
    bar.beginFill(C.dark); bar.drawRect(0, 0, w, tbH); bar.endFill();
    root.addChild(bar);

    // With a subtitle (chapter pages: notebook owner), the title rides slightly
    // above center so the dim owner line tucks beneath it; without one it centers.
    const title = txt(titleStr, Math.round(h * 0.032), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2;
    title.y = subtitleStr ? Math.round(tbH * 0.40) : tbH / 2;
    root.addChild(title);

    if (subtitleStr) {
      const sub = txt(subtitleStr, Math.round(h * 0.020), C.light);
      sub.anchor.set(0.5, 0.5); sub.x = w / 2; sub.y = Math.round(tbH * 0.72);
      sub.alpha = 0.75;
      root.addChild(sub);
    }

    const back = txt(t('campaign.back'), Math.round(h * 0.026), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    root.addChild(back);
    hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: onBack });

    const coll = txt(t('campaign.collection'), Math.round(h * 0.024), C.gold, true);
    coll.anchor.set(1, 0.5); coll.x = w - Math.round(w * 0.04); coll.y = tbH / 2;
    root.addChild(coll);
    hits.push({
      rect: { x: coll.x - coll.width - Math.round(w * 0.03), y: 0, w: coll.width + Math.round(w * 0.06), h: tbH },
      fn: () => this.cb.onOpenCollection(),
    });

    // Equipment entry (E5) — to the left of collection; only when online (server-authoritative).
    if (this.cb.onOpenEquipment) {
      const equip = txt(t('campaign.equipment'), Math.round(h * 0.024), C.accent, true);
      equip.anchor.set(1, 0.5);
      equip.x = coll.x - coll.width - Math.round(w * 0.05); equip.y = tbH / 2;
      root.addChild(equip);
      const open = this.cb.onOpenEquipment;
      hits.push({
        rect: { x: equip.x - equip.width - Math.round(w * 0.02), y: 0, w: equip.width + Math.round(w * 0.04), h: tbH },
        fn: () => open(),
      });
    }

    return tbH;
  }

  // ── Table of contents page ────────────────────────────────────────────────────

  private buildToc(): Page {
    const { w, h } = this;
    const root = new PIXI.Container();
    const hits: Hit[] = [];

    const tbH = this.buildHeader(root, hits, t('campaign.notebookTitle'), () => this.cb.onBack());

    const stars = this.cb.getStars();
    const cleared = new Set(this.cb.getCleared());
    const online = this.cb.isOnline();

    const listX = Math.round(w * 0.12);
    const listW = w - listX - Math.round(w * 0.06);
    const top = tbH + Math.round(h * 0.03);
    const avail = h - top - Math.round(h * 0.03);
    const n = CHAPTER_ORDER.length;
    const gap = Math.round(h * 0.018);
    const cardH = Math.round((avail - gap * (n - 1)) / n);

    CHAPTER_ORDER.forEach((ch, i) => {
      const map = getChapterMap(ch);
      if (!map) return;
      const y = top + i * (cardH + gap);
      const unlocked = isLevelUnlocked(map.nodes[0]!.levelId, cleared);

      const card = sketchPanel(listW, cardH, {
        fill: unlocked ? C.paper : C.btnDis,
        border: unlocked ? C.gold : C.btnOff,
        width: 2, seed: seedFor(listX, y, listW), fillAlpha: unlocked ? 1 : 0.9,
      });
      card.x = listX; card.y = y;
      root.addChild(card);

      const titleStr = `${t('campaign.chapterLabel', { n: ch })} · ${t(map.venueKey)}`;
      const name = txt(titleStr, Math.round(cardH * 0.30), unlocked ? C.dark : C.mid, true);
      name.anchor.set(0, 0.5); name.x = listX + Math.round(w * 0.04); name.y = y + cardH * 0.36;
      root.addChild(name);

      // Progress: cleared count + earned stars.
      const clearedCount = map.nodes.filter((node) => cleared.has(node.levelId)).length;
      const earned = map.nodes.reduce((s, node) => s + (stars[node.levelId] ?? 0), 0);
      const progStr = t('campaign.chapterProgress', { c: clearedCount, n: map.nodes.length });
      const prog = txt(progStr, Math.round(cardH * 0.22), unlocked ? C.mid : C.btnOff);
      prog.anchor.set(0, 0.5); prog.x = listX + Math.round(w * 0.04); prog.y = y + cardH * 0.70;
      root.addChild(prog);

      if (unlocked) {
        const starStr = `★ ${earned}/${map.nodes.length * 3}`;
        const st = txt(starStr, Math.round(cardH * 0.26), C.gold, true);
        st.anchor.set(1, 0.5); st.x = listX + listW - Math.round(w * 0.04); st.y = y + cardH / 2;
        root.addChild(st);
        hits.push({ rect: { x: listX, y, w: listW, h: cardH }, fn: () => this.openChapter(ch) });
      } else {
        // Locked chapter — taped shut.
        this.drawTape(card, listW, cardH, seedFor(listX, cardH, ch));
        const lock = txt(t(online ? 'campaign.locked' : 'campaign.lockedOffline'), Math.round(cardH * 0.22), C.mid);
        lock.anchor.set(1, 0.5); lock.x = listX + listW - Math.round(w * 0.04); lock.y = y + cardH / 2;
        root.addChild(lock);
      }
    });

    return { root, hits, pulse: null };
  }

  private openChapter(ch: number): void {
    if (this.flip) return;
    const dir = ch >= this.chapter ? 1 : -1;
    this.chapter = ch;
    this.flipTo(() => this.buildChapter(ch), dir, () => { this.mode = 'chapter'; });
  }

  // ── Chapter page ────────────────────────────────────────────────────────────

  private buildChapter(ch: number): Page {
    const { w, h } = this;
    const root = new PIXI.Container();
    const hits: Hit[] = [];
    let pulse: PIXI.Graphics | null = null;

    const map = getChapterMap(ch);
    if (!map) return { root, hits, pulse };

    const titleStr = `${t('campaign.chapterLabel', { n: ch })} · ${t(map.venueKey)}`;
    // Narrator attribution: odd chapters are Tao's notebook, even are Anna's
    // (CAMPAIGN_STORY.md framework table — Ch1/3/5 陶, Ch2/4/6 Anna).
    const ownerStr = t(ch % 2 === 1 ? 'campaign.notebookOwner.tao' : 'campaign.notebookOwner.anna');
    const tbH = this.buildHeader(root, hits, titleStr, () => this.backToToc(), ownerStr);

    const stars = this.cb.getStars();
    const cleared = new Set(this.cb.getCleared());
    const online = this.cb.isOnline();
    const pending = new Set(this.cb.getPendingLevels());

    // Content rect (kept right of the red margin at 0.09w, padded all round).
    const cx0 = Math.round(w * 0.14);
    const cy0 = tbH + Math.round(h * 0.05);
    const cw = w - cx0 - Math.round(w * 0.06);
    const cph = h - cy0 - Math.round(h * 0.05);
    const px = (nx: number) => cx0 + Math.max(0, Math.min(1, nx)) * cw;
    const py = (ny: number) => cy0 + Math.max(0, Math.min(1, ny)) * cph;

    // Decor doodles first (behind nodes/path).
    if (map.decor) {
      for (const d of map.decor) this.drawDecor(root, d.kind, px(d.x), py(d.y), Math.round(h * 0.03));
    }

    // Pencil trail threading the nodes in order.
    this.drawTrail(root, map, px, py);

    // The current playable node = first unlocked & uncleared node this chapter.
    const currentLevelId = currentLevelIdInChapter(ch, cleared);

    map.nodes.forEach((node, i) => {
      const cx = px(node.x), cy = py(node.y);
      const unlocked = isLevelUnlocked(node.levelId, cleared);
      const isCleared = cleared.has(node.levelId);
      const isCurrent = node.levelId === currentLevelId;
      const ring = this.drawNode(
        root, cx, cy, node, i, unlocked, isCleared, isCurrent,
        stars[node.levelId] ?? 0, pending.has(node.levelId),
      );
      if (isCurrent && ring) pulse = ring;
      if (unlocked) {
        const r = Math.round(h * 0.04);
        hits.push({ rect: { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, fn: () => this.cb.onSelectLevel(node.levelId) });
      }
    });

    // Chapter-cleared stamp by the title once every node is cleared (§12.2 ceremony).
    if (map.nodes.every((nd) => cleared.has(nd.levelId))) {
      this.drawClearStamp(root, ch, w - Math.round(w * 0.30), tbH + Math.round(h * 0.06));
    }

    // Prev / next chapter arrows (next only once this chapter is fully cleared).
    const idx = CHAPTER_ORDER.indexOf(ch);
    if (idx > 0) {
      const prevCh = CHAPTER_ORDER[idx - 1]!;
      const a = txt('‹', Math.round(h * 0.06), C.mid, true);
      a.anchor.set(0.5); a.x = Math.round(w * 0.05); a.y = (tbH + h) / 2;
      root.addChild(a);
      hits.push({ rect: { x: 0, y: tbH, w: Math.round(w * 0.12), h: h - tbH }, fn: () => this.openChapter(prevCh) });
    }
    if (idx < CHAPTER_ORDER.length - 1) {
      const nextCh = CHAPTER_ORDER[idx + 1]!;
      const nextMap = getChapterMap(nextCh);
      const nextUnlocked = nextMap ? isLevelUnlocked(nextMap.nodes[0]!.levelId, cleared) : false;
      const a = txt('›', Math.round(h * 0.06), nextUnlocked ? C.accent : C.btnOff, true);
      a.anchor.set(0.5); a.x = w - Math.round(w * 0.05); a.y = (tbH + h) / 2;
      root.addChild(a);
      if (nextUnlocked) {
        hits.push({ rect: { x: w - Math.round(w * 0.12), y: tbH, w: Math.round(w * 0.12), h: h - tbH }, fn: () => this.openChapter(nextCh) });
      }
    }

    return { root, hits, pulse };
  }

  private backToToc(): void {
    if (this.flip) return;
    this.flipTo(() => this.buildToc(), -1, () => { this.mode = 'toc'; });
  }

  /** Draw one level node; returns the pulse ring Graphics if `isCurrent`. */
  private drawNode(
    root: PIXI.Container, cx: number, cy: number, node: ChapterNode, i: number,
    unlocked: boolean, isCleared: boolean, isCurrent: boolean,
    starCount: number, pending: boolean,
  ): PIXI.Graphics | null {
    const { h } = this;
    const r = Math.round(h * 0.032);
    const parsed = parseLevelId(node.levelId);
    const lvIndex = parsed?.lvIndex ?? (i + 1);

    const g = new PIXI.Graphics();
    const pen = new SketchPen(g, seedFor(cx, cy, r));
    if (unlocked) {
      g.beginFill(isCleared ? C.gold : C.paper, isCleared ? 0.22 : 1);
      g.drawCircle(cx, cy, r); g.endFill();
      pen.circle(cx, cy, r, { color: isCleared ? C.gold : C.accent, width: 2.4, jitter: 1.0 });
    } else {
      // Locked — faint pencil outline only.
      pen.circle(cx, cy, r, { color: palette.pencilLight, width: 1.6, jitter: 1.2, double: false });
    }
    root.addChild(g);

    const num = txt(String(lvIndex), Math.round(r * 1.0), unlocked ? (isCleared ? C.gold : C.dark) : C.btnOff, true);
    num.anchor.set(0.5); num.x = cx; num.y = cy;
    root.addChild(num);

    if (unlocked && isCleared) {
      const starStr = '★'.repeat(starCount) + '☆'.repeat(3 - starCount);
      const st = txt(starStr, Math.round(r * 0.62), C.gold);
      st.anchor.set(0.5, 0); st.x = cx; st.y = cy + r + Math.round(h * 0.004);
      root.addChild(st);
    } else if (unlocked && pending) {
      const pd = txt(t('campaign.pending'), Math.round(r * 0.55), C.mid);
      pd.anchor.set(0.5, 0); pd.x = cx; pd.y = cy + r + Math.round(h * 0.004);
      root.addChild(pd);
    }

    if (isCurrent) {
      const ring = new PIXI.Graphics();
      new SketchPen(ring, seedFor(cx, cy, r + 5)).circle(0, 0, r + Math.round(h * 0.012), {
        color: C.accent, width: 2.6, jitter: 0.9, double: false,
      });
      ring.x = cx; ring.y = cy;
      root.addChild(ring);
      return ring;
    }
    return null;
  }

  /** Pencil dashed trail through the nodes (or an explicit point list). */
  private drawTrail(root: PIXI.Container, map: ChapterMap, px: (n: number) => number, py: (n: number) => number): void {
    const pts = (map.path && map.path !== 'auto' ? map.path : map.nodes).map((p) => ({ x: px(p.x), y: py(p.y) }));
    if (pts.length < 2) return;
    const g = new PIXI.Graphics();
    const pen = new SketchPen(g, seedFor(pts[0]!.x, pts[0]!.y, pts.length));
    const dash = Math.round(this.h * 0.018), gapLen = Math.round(this.h * 0.012);
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s]!, b = pts[s + 1]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      for (let d = 0; d < len; d += dash + gapLen) {
        const d2 = Math.min(len, d + dash);
        pen.line(a.x + ux * d, a.y + uy * d, a.x + ux * d2, a.y + uy * d2, {
          color: palette.pencilLight, width: 1.8, jitter: 0.7, taper: 0.8, double: false,
        });
      }
    }
    root.addChildAt(g, 0); // behind nodes, but the bg paper is on the container, not the page root
  }

  // ── Procedural doodle decor ───────────────────────────────────────────────────

  private drawDecor(root: PIXI.Container, kind: string, x: number, y: number, s: number): void {
    const g = new PIXI.Graphics();
    const pen = new SketchPen(g, seedFor(x, y, s));
    switch (kind) {
      case 'start': {
        pen.line(x, y - s, x, y + s, { color: palette.pencil, width: 2.2 });
        const fl = new PIXI.Graphics();
        fl.beginFill(C.green, 0.85); fl.drawPolygon([x, y - s, x + s * 1.3, y - s * 0.6, x, y - s * 0.2]); fl.endFill();
        root.addChild(fl);
        const lbl = txt(t('campaign.markerStart'), Math.round(s * 0.62), C.green, true);
        lbl.anchor.set(0.5, 0); lbl.x = x; lbl.y = y + s * 0.2; root.addChild(lbl);
        break;
      }
      case 'boss': {
        pen.line(x, y - s, x, y + s, { color: palette.pencil, width: 2.2 });
        const fl = new PIXI.Graphics();
        fl.beginFill(C.red, 0.85); fl.drawPolygon([x, y - s, x + s * 1.4, y - s * 0.55, x, y - s * 0.1]); fl.endFill();
        root.addChild(fl);
        const lbl = txt(t('campaign.markerBoss'), Math.round(s * 0.62), C.red, true);
        lbl.anchor.set(0.5, 0); lbl.x = x; lbl.y = y + s * 0.2; root.addChild(lbl);
        break;
      }
      case 'rack': // spear rack — an X of two strokes on a baseline
        pen.line(x - s, y + s, x + s, y - s, { color: palette.pencilLight, width: 2.0, double: false });
        pen.line(x - s, y - s, x + s, y + s, { color: palette.pencilLight, width: 2.0, double: false });
        pen.line(x - s * 1.2, y + s, x + s * 1.2, y + s, { color: palette.pencilLight, width: 1.6, double: false });
        break;
      case 'flag':
      case 'banner': {
        pen.line(x, y - s, x, y + s, { color: palette.pencilLight, width: 2.0 });
        const fl = new PIXI.Graphics();
        fl.beginFill(C.accent, 0.55); fl.drawPolygon([x, y - s, x + s, y - s * 0.6, x, y - s * 0.2]); fl.endFill();
        root.addChild(fl);
        break;
      }
      case 'tent':
        pen.line(x - s, y + s, x, y - s, { color: palette.pencilLight, width: 2.0, double: false });
        pen.line(x + s, y + s, x, y - s, { color: palette.pencilLight, width: 2.0, double: false });
        pen.line(x - s, y + s, x + s, y + s, { color: palette.pencilLight, width: 1.6, double: false });
        break;
      case 'tree':
        pen.line(x, y + s, x, y - s * 0.2, { color: palette.pencil, width: 2.0, double: false });
        pen.circle(x, y - s * 0.5, s * 0.7, { color: palette.pencilLight, width: 1.6, double: false });
        break;
      case 'rock':
        pen.circle(x, y, s * 0.7, { color: palette.pencilLight, width: 1.8, double: false });
        break;
      default:
        return; // unknown kind — forward-compatible skip
    }
    root.addChild(g);
  }

  /** A taped-shut overlay on a locked TOC card. */
  private drawTape(card: PIXI.Graphics, w: number, h: number, seed: number): void {
    const tw = Math.round(w * 0.18), th = Math.round(h * 0.5);
    const tape = new PIXI.Graphics();
    tape.beginFill(C.gold, 0.28); tape.drawRect(-tw / 2, -th / 2, tw, th); tape.endFill();
    new SketchPen(tape, seed).rect(-tw / 2, -th / 2, tw, th, { color: C.gold, width: 1.4, alpha: 0.5, double: false });
    tape.x = w * 0.5; tape.y = h * 0.5; tape.rotation = -0.35;
    card.addChild(tape);
  }

  /** Rotated「第 N 章 · 通关」stamp near the chapter title. */
  private drawClearStamp(root: PIXI.Container, ch: number, x: number, y: number): void {
    const wrap = new PIXI.Container();
    const label = `${t('campaign.chapterLabel', { n: ch })} · ${t('campaign.chapterStamp')}`;
    const tx = txt(label, Math.round(this.h * 0.024), C.red, true);
    tx.anchor.set(0.5);
    const pad = Math.round(this.h * 0.012);
    const box = new PIXI.Graphics();
    new SketchPen(box, seedFor(x, y, ch)).rect(
      -tx.width / 2 - pad, -tx.height / 2 - pad / 2, tx.width + pad * 2, tx.height + pad, { color: C.red, width: 2.2 },
    );
    wrap.addChild(box); wrap.addChild(tx);
    wrap.x = x; wrap.y = y; wrap.rotation = -0.18; wrap.alpha = 0.85;
    root.addChild(wrap);
  }
}
