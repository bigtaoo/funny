import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, type TranslationKey } from '../i18n';
import { UnitType } from '../game';
import { TRAIT_BREAKPOINTS, UNIT_MAX_LEVEL } from '../game/balance/progression';
import {
  PROGRESSABLE_UNIT_IDS,
  MERGE_COPIES,
  cardKey,
} from '../game/balance/unitCards';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';

// ── LevelPrepScene (S12) — unit card level view + merge + Start ─────────────
//
// Shows each progressable unit's current level (derived from cardInventory),
// any unlocked traits (T3/T6/T9 breakpoints), and a per-level merge button
// (5 cards of level N → 1 card of level N+1). Replaces the S3-2 material +
// upgrade-tree system. The hard wall (§5.2) means levels only ever buff the
// campaign engine; buildPvpBlueprints never receives unitLevels.

const UNIT_NAME_KEY: Partial<Record<UnitType, TranslationKey>> = {
  [UnitType.Infantry]: 'card.infantry.name',
  [UnitType.ShieldBearer]: 'card.shieldbearer.name',
  [UnitType.Archer]: 'card.archer.name',
};

export interface LevelPrepCallbacks {
  onBack(): void;
  onStart(): void;
  /** unitId → current level (1–9); missing key = Lv 1. */
  getUnitLevels(): Record<string, number>;
  /** cardKey (unitId:level) → owned count. */
  getCardInventory(): Record<string, number>;
  /** Online = can reach /pve/merge. Offline disables merging. */
  isOnline(): boolean;
  /** Server-authoritative merge (5 × unitId:level → 1 × unitId:(level+1)); true on success. */
  tryMerge(unitId: string, level: number): Promise<boolean>;
  /** 1-based level number for the header label. */
  levelNumber: number;
  /** Pre-translated story brief shown in a panel above the unit list. */
  brief?: string;
  /** Pre-translated story intro shown as a tap-through overlay when the player hits Start. */
  intro?: string;
  /** Stamina cost to play this level (A4). Default = 1. */
  staminaCost: number;
  /** Current stamina snapshot (A4): { current, regenAt }. */
  getStamina(): { current: number; regenAt: number };
  /** Navigate to shop/commercial to purchase stamina (A4). */
  onBuyStamina(): void;
}

interface Hit { rect: Rect; fn: () => void; }

export class LevelPrepScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: LevelPrepCallbacks;
  private hits: Hit[] = [];
  private readonly unsubs: Array<() => void> = [];
  private toast: { text: string; color: number } | null = null;
  private merging = false;

  // ── Intro story animation state ───────────────────────────────────────────
  private showingIntro = false;
  private introLines: string[] = [];
  private introShownCount = 0;
  private introFadeT = 0;
  private introLineTexts: PIXI.Text[] = [];
  private introSkipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(layout: ILayout, input: InputManager, cb: LevelPrepCallbacks) {
    this.container = new PIXI.Container();
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
  }

  update(dt: number): void {
    if (!this.showingIntro || this.introLineTexts.length === 0) return;
    if (this.introShownCount > 0 && this.introShownCount <= this.introLineTexts.length) {
      const line = this.introLineTexts[this.introShownCount - 1]!;
      if (line.alpha < 1) {
        this.introFadeT += dt;
        line.alpha = Math.min(1, this.introFadeT / 0.8);
      }
    }
  }

  destroy(): void { this.unsubs.forEach((u) => u()); }

  private handleDown(x: number, y: number): void {
    if (this.showingIntro) {
      const sr = this.introSkipRect;
      if (x >= sr.x && x <= sr.x + sr.w && y >= sr.y && y <= sr.y + sr.h) {
        this.finishIntro(); return;
      }
      const current = this.introLineTexts[this.introShownCount - 1];
      if (current && current.alpha < 1) {
        current.alpha = 1;
      } else if (this.introShownCount < this.introLineTexts.length) {
        this.introShownCount++;
        this.introFadeT = 0;
      } else {
        this.finishIntro();
      }
      return;
    }
    for (const hit of this.hits) {
      const r = hit.rect;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hit.fn(); return; }
    }
  }

  private finishIntro(): void {
    this.showingIntro = false;
    this.introLines = [];
    this.introLineTexts = [];
    this.cb.onStart();
  }

  private onMerge(unitId: string, level: number): void {
    if (this.merging) return;
    if (!this.cb.isOnline()) {
      this.toast = { text: t('progression.offlineMerge'), color: C.red };
      this.render();
      return;
    }
    this.merging = true;
    void this.cb.tryMerge(unitId, level).then((ok) => {
      this.merging = false;
      this.toast = ok
        ? { text: t('progression.merged'), color: C.green }
        : { text: t('progression.mergeFail'), color: C.red };
      this.render();
    });
  }

  private render(): void {
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;

    if (this.showingIntro) {
      this.buildIntroLines();
      return;
    }

    this.container.addChild(buildPaperBackground('prepbg', w, h));

    // Header
    const tbH = Math.round(h * 0.12);
    const titleBg = new PIXI.Graphics();
    titleBg.beginFill(C.dark); titleBg.drawRect(0, 0, w, tbH); titleBg.endFill();
    this.container.addChild(titleBg);

    const title = txt(t('campaign.levelLabel', { n: this.cb.levelNumber }), Math.round(h * 0.032), 0xffffff, true);
    title.anchor.set(0.5, 0.5); title.x = w / 2; title.y = tbH / 2;
    this.container.addChild(title);

    const back = txt(t('prep.back'), Math.round(h * 0.024), C.light);
    back.anchor.set(0, 0.5); back.x = Math.round(w * 0.04); back.y = tbH / 2;
    this.container.addChild(back);
    this.hits.push({
      rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH },
      fn: () => this.cb.onBack(),
    });

    let y = tbH + Math.round(h * 0.02);

    if (this.cb.brief) {
      y = this.drawBrief(y);
    }

    // Section title
    const secLbl = txt(t('progression.unitsTitle'), Math.round(h * 0.026), C.dark, true);
    secLbl.anchor.set(0, 0.5);
    secLbl.x = Math.round(w * 0.08);
    secLbl.y = y + Math.round(h * 0.018);
    this.container.addChild(secLbl);
    y += Math.round(h * 0.048);

    // Unit card rows
    const listX = Math.round(w * 0.06);
    const listW = w - listX * 2;
    const rowH = Math.round(h * 0.13);
    const gap = Math.round(h * 0.016);
    const unitLevels = this.cb.getUnitLevels();
    const inv = this.cb.getCardInventory();

    for (const unitId of PROGRESSABLE_UNIT_IDS) {
      this.drawUnitRow(unitId, unitLevels[unitId] ?? 1, inv, listX, y, listW, rowH);
      y += rowH + gap;
    }

    // —— 体力栏（A4）: 消耗 + 当前余量，不足时变红 + 补给按钮 ——
    const stamina = this.cb.getStamina();
    const stCost = this.cb.staminaCost;
    const stInsufficient = stamina.current < stCost;
    const stBarH = Math.round(h * 0.055);
    const stBarY = h - stBarH - Math.round(h * 0.14);
    const stColor = stInsufficient ? C.red : C.accent;
    const stTxt = txt(
      t('stamina.cost', { cost: stCost, current: stamina.current }),
      Math.round(stBarH * 0.48),
      stColor,
      true,
    );
    stTxt.anchor.set(0.5, 0.5); stTxt.x = w / 2; stTxt.y = stBarY + stBarH / 2;
    this.container.addChild(stTxt);
    if (stInsufficient) {
      const buyW = Math.round(w * 0.45);
      const buyH = Math.round(h * 0.065);
      const buyX = (w - buyW) / 2;
      const buyY = stBarY + stBarH + Math.round(h * 0.008);
      const buyBg = sketchPanel(buyW, buyH, { fill: C.red, border: C.dark, width: 1.6, seed: seedFor(buyX, buyY, buyW) });
      buyBg.x = buyX; buyBg.y = buyY;
      this.container.addChild(buyBg);
      const buyLbl = txt(t('stamina.buy'), Math.round(buyH * 0.4), 0xffffff, true);
      buyLbl.anchor.set(0.5, 0.5); buyLbl.x = buyX + buyW / 2; buyLbl.y = buyY + buyH / 2;
      this.container.addChild(buyLbl);
      this.hits.push({ rect: { x: buyX, y: buyY, w: buyW, h: buyH }, fn: () => this.cb.onBuyStamina() });
    }

    // Start button
    const sbW = Math.round(w * 0.6);
    const sbH = Math.round(h * 0.08);
    const sbX = (w - sbW) / 2;
    const sbY = h - sbH - Math.round(h * 0.03);
    // 体力不足时 Start 按钮置灰，阻止进关。
    const sbFill = stInsufficient ? C.btnOff : C.dark;
    const sbBorder = stInsufficient ? C.mid : C.green;
    const sb = sketchPanel(sbW, sbH, { fill: sbFill, border: sbBorder, width: 2.6, seed: seedFor(sbX, sbY, sbW) });
    sb.x = sbX; sb.y = sbY;
    this.container.addChild(sb);
    const sl = txt(t('prep.start'), Math.round(sbH * 0.42), stInsufficient ? C.mid : 0xffffff, true);
    sl.anchor.set(0.5, 0.5); sl.x = sbX + sbW / 2; sl.y = sbY + sbH / 2;
    this.container.addChild(sl);
    this.hits.push({
      rect: { x: sbX, y: sbY, w: sbW, h: sbH },
      fn: () => {
        if (stInsufficient) return; // 体力不足，拦截点击
        if (this.cb.intro) {
          this.introLines = this.cb.intro.split('\n').filter((l) => l.trim().length > 0);
          this.introShownCount = 0;
          this.introFadeT = 0;
          this.introLineTexts = [];
          this.showingIntro = true;
          this.render();
        } else {
          this.cb.onStart();
        }
      },
    });

    if (this.toast) this.drawToast();
  }

  private drawUnitRow(
    unitId: string,
    level: number,
    inv: Record<string, number>,
    x: number,
    y: number,
    w: number,
    h: number,
  ): void {
    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, C.accent, seedFor(x, h, 5));
    this.container.addChild(box);

    const unitType = unitId as UnitType;
    const unitName = UNIT_NAME_KEY[unitType] ? t(UNIT_NAME_KEY[unitType]!) : unitId;
    const fs = Math.round(h * 0.22);
    const nameTxt = txt(unitName, fs, C.dark, true);
    nameTxt.anchor.set(0, 0.5);
    nameTxt.x = x + Math.round(w * 0.04);
    nameTxt.y = y + h * 0.3;
    this.container.addChild(nameTxt);

    const lvTxt = txt(t('progression.lv', { lv: level }), Math.round(h * 0.2), level >= UNIT_MAX_LEVEL ? C.gold : C.mid);
    lvTxt.anchor.set(0, 0.5);
    lvTxt.x = x + Math.round(w * 0.04);
    lvTxt.y = y + h * 0.72;
    this.container.addChild(lvTxt);

    // Trait badges (T3/T6/T9)
    const traits: Array<{ key: TranslationKey; minLevel: number }> = [
      { key: 'progression.trait.crit', minLevel: TRAIT_BREAKPOINTS.crit.level },
      { key: 'progression.trait.lifesteal', minLevel: TRAIT_BREAKPOINTS.lifesteal.level },
      { key: 'progression.trait.spawn', minLevel: TRAIT_BREAKPOINTS.bonusSpawn.level },
    ];
    let traitX = x + Math.round(w * 0.3);
    const traitY = y + h * 0.5;
    const traitFs = Math.round(h * 0.17);
    for (const trait of traits) {
      const unlocked = level >= trait.minLevel;
      const badge = txt(t(trait.key), traitFs, unlocked ? C.green : C.btnOff, true);
      badge.anchor.set(0, 0.5);
      badge.x = traitX;
      badge.y = traitY;
      this.container.addChild(badge);
      traitX += badge.width + Math.round(w * 0.015);
    }

    // Merge button: find lowest level with ≥ MERGE_COPIES cards that can still be merged
    const mergeLevel = this.findMergeLevel(unitId, inv);
    const bw = Math.round(w * 0.18);
    const bh = Math.round(h * 0.55);
    const bx = x + w - bw - Math.round(w * 0.03);
    const by = y + (h - bh) / 2;
    const online = this.cb.isOnline();
    const canMerge = mergeLevel !== null;
    const enabled = canMerge && online;

    const btn = sketchPanel(bw, bh, {
      fill: enabled ? C.dark : C.btnDis,
      border: enabled ? C.green : C.btnOff,
      width: 2, seed: seedFor(bx, by, bw),
    });
    btn.x = bx; btn.y = by;
    this.container.addChild(btn);
    const blabel = txt(t('progression.merge'), Math.round(bh * 0.34), enabled ? 0xffffff : C.mid, true);
    blabel.anchor.set(0.5, 0.5); blabel.x = bx + bw / 2; blabel.y = by + bh / 2;
    this.container.addChild(blabel);

    if (mergeLevel !== null) {
      const cardCount = inv[cardKey(unitId, mergeLevel)] ?? 0;
      const countTxt = txt(
        t('progression.cards', { n: cardCount }),
        Math.round(bh * 0.26),
        online ? C.gold : C.mid,
        true,
      );
      countTxt.anchor.set(0.5, 0);
      countTxt.x = bx + bw / 2;
      countTxt.y = by + bh;
      this.container.addChild(countTxt);
    }

    if (enabled && mergeLevel !== null) {
      this.hits.push({
        rect: { x: bx, y: by, w: bw, h: bh },
        fn: () => this.onMerge(unitId, mergeLevel),
      });
    }
  }

  /** Returns lowest card level with ≥ MERGE_COPIES cards that is < UNIT_MAX_LEVEL, or null. */
  private findMergeLevel(unitId: string, inv: Record<string, number>): number | null {
    for (let lv = 1; lv < UNIT_MAX_LEVEL; lv++) {
      const count = inv[cardKey(unitId, lv)] ?? 0;
      if (count >= MERGE_COPIES) return lv;
    }
    return null;
  }

  private drawBrief(y: number): number {
    const { w, h } = this;
    const padX = Math.round(w * 0.06);
    const panW = w - padX * 2;
    const fontSize = Math.round(h * 0.022);
    const lineH = Math.round(fontSize * 1.5);
    const maxLines = 3;
    const panH = Math.round(h * 0.005) * 2 + lineH * maxLines;

    const bg = sketchPanel(panW, panH, {
      fill: C.paper, border: C.line, width: 1.2, seed: seedFor(padX, y, panW),
    });
    bg.x = padX; bg.y = y;
    sketchAccentBar(bg, panH, C.accent, seedFor(padX, panH, 7));
    this.container.addChild(bg);

    const scratch = txt(this.cb.brief!, fontSize, C.mid);
    scratch.style.wordWrap = true;
    scratch.style.wordWrapWidth = panW - Math.round(panW * 0.12);
    scratch.anchor.set(0, 0);
    scratch.x = padX + Math.round(panW * 0.06);
    scratch.y = y + Math.round(panH * 0.1);
    this.container.addChild(scratch);

    return y + panH + Math.round(h * 0.015);
  }

  private buildIntroLines(): void {
    this.container.removeChildren();
    const { w, h } = this;

    const bg = new PIXI.Graphics();
    bg.beginFill(0x1a1408, 0.97); bg.drawRect(0, 0, w, h); bg.endFill();
    this.container.addChild(bg);

    const fontSize = Math.round(h * 0.026);
    const lineGapY = Math.round(h * 0.085);
    const blockH = (this.introLines.length - 1) * lineGapY;
    const startY = (h - blockH) / 2 - Math.round(h * 0.05);

    this.introLineTexts = [];
    this.introLines.forEach((line, i) => {
      const text = new PIXI.Text(line, {
        fontSize,
        fill: 0xe8dfc0,
        fontFamily: 'serif',
        wordWrap: true,
        wordWrapWidth: w * 0.78,
        align: 'center',
        lineHeight: Math.round(fontSize * 1.5),
      });
      text.anchor.set(0.5, 0.5);
      text.x = w / 2;
      text.y = startY + i * lineGapY;
      text.alpha = 0;
      this.container.addChild(text);
      this.introLineTexts.push(text);
    });

    const hint = new PIXI.Text(t('story.tapToContinue'), {
      fontSize: Math.round(h * 0.02),
      fill: 0x8a7a60,
      fontFamily: 'monospace',
    });
    hint.anchor.set(0.5, 1);
    hint.x = w / 2;
    hint.y = h * 0.92;
    this.container.addChild(hint);

    const skipText = new PIXI.Text(t('story.skip'), {
      fontSize: Math.round(h * 0.022),
      fill: 0x8a7a60,
      fontFamily: 'monospace',
    });
    skipText.anchor.set(1, 0);
    skipText.x = w - Math.round(w * 0.04);
    skipText.y = Math.round(h * 0.03);
    this.container.addChild(skipText);

    const pad = Math.round(h * 0.015);
    this.introSkipRect = {
      x: skipText.x - skipText.width - pad,
      y: skipText.y - pad,
      w: skipText.width + pad * 2,
      h: skipText.height + pad * 2,
    };

    this.introShownCount = 1;
    this.introFadeT = 0;
  }

  private drawToast(): void {
    const { w, h } = this;
    const toast = this.toast!;
    const lbl = txt(toast.text, Math.round(h * 0.026), 0xffffff, true);
    const padX = Math.round(w * 0.04);
    const padY = Math.round(h * 0.012);
    const bw = lbl.width + padX * 2;
    const bh = lbl.height + padY * 2;
    const bx = (w - bw) / 2;
    const by = Math.round(h * 0.78);
    const bg = sketchPanel(bw, bh, { fill: toast.color, fillAlpha: 0.95, border: toast.color, width: 2, seed: seedFor(bw, bh, 2) });
    bg.x = bx; bg.y = by;
    this.container.addChild(bg);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    this.container.addChild(lbl);
  }
}
