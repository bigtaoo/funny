import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t } from '../i18n';
import { CHAPTER_ORDER, getChapterMap } from '../game';
import type { ChapterMap } from '../game';
import { isLevelUnlocked, currentChapter, currentLevelIdInChapter } from '../game/campaign/progress';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchButton, seedFor, tearDownChildren } from '../render/sketchUi';
import { FS, snapFont } from '../render/fontScale';
import { buildIcon } from '../render/icons';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import { drawNode, drawTrail, drawDecor, drawTape, drawClearStamp } from './CampaignMapScene/drawing';

// ── CampaignMapScene (S3-5 → CAMPAIGN_DESIGN §12) — the "campaign notebook" ──────
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
  /**
   * Open the growth hub (E5 + collection, LOBBY_IA_REDESIGN §9: merged into a single header
   * entry). Server-authoritative equipment lands directly on the Equipment tab when online;
   * the nav layer falls back to the Collection (skins) screen when offline/logged out.
   */
  onOpenEquipment(): void;
  /** Stars earned per level id (0..3); absent = 0. */
  getStars(): Record<string, 1 | 2 | 3>;
  /** Cleared level ids — drives the sequential unlock gate. */
  getCleared(): string[];
  /** Online = can reach /pve/* (clear/unlock are server-authoritative, §8). Offline gates new unlocks. */
  isOnline(): boolean;
  /** Level ids with an offline clear queued for settlement (shown as "pending settlement"). */
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
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));

    // Land DIRECTLY on the current chapter (progress landing, §12.2).
    //
    // This used to open on the TOC and auto-flip to the chapter — a cosmetic
    // "book opening". But that gated EVERY tap target behind the opening flip:
    // during a flip `this.hits = []` and `handleDown` is a no-op, and the flip
    // only settles from `update()`. If the ticker stalled for any reason the
    // scene rendered but was completely dead — no level select, no way back —
    // which is exactly the recurring "can't select a level / can't get back to the lobby" bug. Building the
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

  destroy(): void {
    this.unsubs.forEach((u) => u());
    // Free the Text baseTextures across the whole tree before dropping the container — a bare
    // container.destroy({children:true}) destroys the Text objects but orphans their textures
    // (texture defaults to false for descendants). Also frees any boiling-line Ticker.shared
    // closures inside them — previously only input was unsubscribed, leaking every child's
    // shared-ticker tick across navigations.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }

  // ── Page lifecycle ────────────────────────────────────────────────────────────

  private showPage(p: Page): void {
    if (this.page) {
      this.container.removeChild(this.page.root);
      // Same Text-texture concern as destroy() above, but repeated every TOC↔chapter
      // navigation within this single scene instance (not just once on scene exit) —
      // left as a bare destroy this leaked one screenful of Text per flip.
      tearDownChildren(this.page.root);
      this.page.root.destroy({ children: true });
    }
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
      // Same repeated-per-flip Text-texture concern as showPage() above.
      tearDownChildren(f.out);
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
  private buildHeader(
    root: PIXI.Container, hits: Hit[], titleStr: string, onBack: () => void, subtitleStr?: string,
    showChaptersButton?: boolean,
  ): number {
    const { w, h } = this;
    // Top-bar chrome (dark strip + back button top-left) is handled by SceneHeader;
    // the title is drawn by this scene (when a subtitle is present the title rises slightly;
    // §3.1 allows title=null to let the scene own the title area).
    const hdr = drawSceneHeader(root, w, h, null);
    const tbH = hdr.headerH;

    // With a subtitle (chapter pages: notebook owner), the title rides slightly
    // above center so the dim owner line tucks beneath it; without one it centers.
    const title = txt(titleStr, FS.title, C.dark, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2;
    title.y = subtitleStr ? Math.round(tbH * 0.40) : tbH / 2;
    root.addChild(title);

    if (subtitleStr) {
      const sub = txt(subtitleStr, FS.label, C.mid);
      sub.anchor.set(0.5, 0.5); sub.x = w / 2; sub.y = Math.round(tbH * 0.72);
      sub.alpha = 0.75;
      root.addChild(sub);
    }

    hits.push({ rect: hdr.backRect, fn: onBack });

    // Right-aligned header shortcuts, each on the one true primary-button
    // background (sketchButton, §7.5) so they read as real buttons — matching
    // the Back pill — rather than bare gold text floating on the paper bar.
    // Laid out right→left; `rightX` walks left by each pill's width + gap.
    const fontSz = FS.label;
    const padX = Math.round(fontSz * 0.8);
    const pillH = Math.round(fontSz + padX * 1.4);
    const pillGap = Math.round(w * 0.02);
    let rightX = w - Math.round(w * 0.04);

    const addHeaderButton = (labelStr: string, fn: () => void): void => {
      const label = txt(labelStr, fontSz, C.gold, true);
      const pillW = Math.round(label.width + padX * 2);
      const pillX = rightX - pillW;
      const pillY = Math.round((tbH - pillH) / 2);

      const bg = sketchButton(pillW, pillH, seedFor(pillX, pillY, pillW));
      bg.x = pillX; bg.y = pillY;
      root.addChild(bg);

      label.anchor.set(0.5, 0.5);
      label.x = pillX + pillW / 2; label.y = tbH / 2;
      root.addChild(label);

      hits.push({ rect: { x: pillX, y: pillY, w: pillW, h: pillH }, fn });
      rightX = pillX - pillGap;
    };

    // Single growth-hub entry (LOBBY_IA_REDESIGN §9): merges the former separate
    // Collection/Equipment header links, matching the lobby's unified [Collection|Equipment] tab.
    addHeaderButton(t('campaign.equipment'), () => this.cb.onOpenEquipment());

    // Chapter-page-only shortcut to the notebook overview (TOC), since Back now exits to the lobby directly.
    if (showChaptersButton) {
      addHeaderButton(t('campaign.chapters'), () => this.backToToc());
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
      const name = txt(titleStr, snapFont(Math.round(cardH * 0.30)), unlocked ? C.dark : C.mid, true);
      name.anchor.set(0, 0.5); name.x = listX + Math.round(w * 0.04); name.y = y + cardH * 0.36;
      root.addChild(name);

      // Progress: cleared count + earned stars.
      const clearedCount = map.nodes.filter((node) => cleared.has(node.levelId)).length;
      const earned = map.nodes.reduce((s, node) => s + (stars[node.levelId] ?? 0), 0);
      const progStr = t('campaign.chapterProgress', { c: clearedCount, n: map.nodes.length });
      const prog = txt(progStr, snapFont(Math.round(cardH * 0.22)), unlocked ? C.mid : C.btnOff);
      prog.anchor.set(0, 0.5); prog.x = listX + Math.round(w * 0.04); prog.y = y + cardH * 0.70;
      root.addChild(prog);

      if (unlocked) {
        // Hand-drawn star glyph + earned/total count (replaces the ★ text bullet).
        const rightX = listX + listW - Math.round(w * 0.04);
        const st = txt(`${earned}/${map.nodes.length * 3}`, snapFont(Math.round(cardH * 0.26)), C.gold, true);
        st.anchor.set(1, 0.5); st.x = rightX; st.y = y + cardH / 2;
        root.addChild(st);
        const starSz = Math.round(cardH * 0.28);
        const starIc = buildIcon('star', starSz, C.gold);
        starIc.x = rightX - st.width - starSz - 4; starIc.y = y + cardH / 2 - starSz / 2;
        root.addChild(starIc);
        hits.push({ rect: { x: listX, y, w: listW, h: cardH }, fn: () => this.openChapter(ch) });
      } else {
        // Locked chapter — taped shut.
        drawTape(card, listW, cardH, seedFor(listX, cardH, ch));
        const lock = txt(t(online ? 'campaign.locked' : 'campaign.lockedOffline'), snapFont(Math.round(cardH * 0.22)), C.mid);
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
    // (CAMPAIGN_STORY.md framework table — Ch1/3/5 Tao, Ch2/4/6 Anna).
    const ownerStr = t(ch % 2 === 1 ? 'campaign.notebookOwner.tao' : 'campaign.notebookOwner.anna');
    const tbH = this.buildHeader(root, hits, titleStr, () => this.cb.onBack(), ownerStr, true);

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
      for (const d of map.decor) drawDecor(root, d.kind, px(d.x), py(d.y), Math.round(h * 0.03));
    }

    // Pencil trail threading the nodes in order.
    drawTrail(root, map, px, py, h);

    // The current playable node = first unlocked & uncleared node this chapter.
    const currentLevelId = currentLevelIdInChapter(ch, cleared);

    map.nodes.forEach((node, i) => {
      const cx = px(node.x), cy = py(node.y);
      const unlocked = isLevelUnlocked(node.levelId, cleared);
      const isCleared = cleared.has(node.levelId);
      const isCurrent = node.levelId === currentLevelId;
      const ring = drawNode(
        root, cx, cy, node, i, unlocked, isCleared, isCurrent,
        stars[node.levelId] ?? 0, pending.has(node.levelId), h,
      );
      if (isCurrent && ring) pulse = ring;
      if (unlocked) {
        const r = Math.round(h * 0.04);
        hits.push({ rect: { x: cx - r, y: cy - r, w: r * 2, h: r * 2 }, fn: () => this.cb.onSelectLevel(node.levelId) });
      }
    });

    // Chapter-cleared stamp by the title once every node is cleared (§12.2 ceremony).
    if (map.nodes.every((nd) => cleared.has(nd.levelId))) {
      drawClearStamp(root, ch, w - Math.round(w * 0.30), tbH + Math.round(h * 0.06), h);
    }

    // Prev / next chapter arrows (next only once this chapter is fully cleared).
    const idx = CHAPTER_ORDER.indexOf(ch);
    if (idx > 0) {
      const prevCh = CHAPTER_ORDER[idx - 1]!;
      const a = txt('‹', FS.display, C.mid, true);
      a.anchor.set(0.5); a.x = Math.round(w * 0.05); a.y = (tbH + h) / 2;
      root.addChild(a);
      hits.push({ rect: { x: 0, y: tbH, w: Math.round(w * 0.12), h: h - tbH }, fn: () => this.openChapter(prevCh) });
    }
    if (idx < CHAPTER_ORDER.length - 1) {
      const nextCh = CHAPTER_ORDER[idx + 1]!;
      const nextMap = getChapterMap(nextCh);
      const nextUnlocked = nextMap ? isLevelUnlocked(nextMap.nodes[0]!.levelId, cleared) : false;
      const a = txt('›', FS.display, nextUnlocked ? C.accent : C.btnOff, true);
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

}
