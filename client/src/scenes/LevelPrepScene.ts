import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout, Rect } from '../layout/ILayout';
import { InputManager } from '../inputSystem/InputManager';
import { t, type TranslationKey } from '../i18n';
import { UnitType } from '../game';
import {
  PVE_UPGRADE_DEFS,
  MATERIAL_ORDER,
  upgradeCost,
  type PveUpgradeDef,
} from '../game/balance/pveUpgrades';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';

// ── LevelPrepScene (S3-5) — pre-battle upgrades (养成) + start ──────────────────
//
// Spend level-drop materials on the unit upgrade tree (game/balance/pveUpgrades),
// then launch the battle. Upgrades / materials live in the client-sync SaveData
// segment; the app applies the spend via SaveManager (this scene calls back and
// re-reads). The hard wall (§5.2) means these only ever buff the campaign engine.

/** i18n key for each upgradable unit's display name (reuses the card names). */
const UNIT_NAME_KEY: Partial<Record<UnitType, TranslationKey>> = {
  [UnitType.Infantry]: 'card.infantry.name',
  [UnitType.ShieldBearer]: 'card.shieldbearer.name',
  [UnitType.Archer]: 'card.archer.name',
};

export interface LevelPrepCallbacks {
  onBack(): void;
  onStart(): void;
  /** Material id → owned amount. */
  getMaterials(): Record<string, number>;
  /** Upgrade id → current level. */
  getUpgradeLevel(id: string): number;
  /** Online = can reach /pve/upgrade (upgrades are server-authoritative, §8). Offline disables upgrading. */
  isOnline(): boolean;
  /** Buy one level of `id` (server-authoritative spend); resolves true on success. */
  tryUpgrade(id: string): Promise<boolean>;
  /** 1-based level number for the header label. */
  levelNumber: number;
  /** Pre-translated story brief shown in a panel above the upgrade list. */
  brief?: string;
  /** Pre-translated story intro shown as a tap-through overlay when the player hits Start. */
  intro?: string;
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
      // Skip button
      const sr = this.introSkipRect;
      if (x >= sr.x && x <= sr.x + sr.w && y >= sr.y && y <= sr.y + sr.h) {
        this.finishIntro();
        return;
      }
      // Tap: complete in-progress fade → advance → finish
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

  private upgrading = false;

  // ── Intro story animation state (IntroScene-style line-by-line fade-in) ──
  private showingIntro = false;
  private introLines: string[] = [];
  private introShownCount = 0;  // lines requested so far
  private introFadeT = 0;       // current line fade progress (seconds)
  private introLineTexts: PIXI.Text[] = [];
  private introSkipRect: Rect = { x: 0, y: 0, w: 0, h: 0 };

  private onUpgrade(def: PveUpgradeDef): void {
    if (this.upgrading) return; // 防连点重复扣费（服务器端点在途）
    if (!this.cb.isOnline()) {
      this.toast = { text: t('prep.offlineUpgrade'), color: C.red };
      this.render();
      return;
    }
    this.upgrading = true;
    void this.cb.tryUpgrade(def.id).then((ok) => {
      this.upgrading = false;
      this.toast = ok
        ? { text: t('prep.upgraded'), color: C.green }
        : { text: t('prep.insufficient'), color: C.red };
      this.render(); // 重读 save 镜像（已被回推刷新）
    });
  }

  private render(): void {
    this.container.removeChildren();
    this.hits = [];
    const { w, h } = this;

    // ── Intro story overlay (shown when player taps Start and introKey is set) ──
    if (this.showingIntro) {
      this.buildIntroLines();
      return;
    }

    this.container.addChild(buildPaperBackground('prepbg', w, h));

    // Header: back + level label + start.
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
    this.hits.push({ rect: { x: 0, y: 0, w: back.x + back.width + Math.round(h * 0.02), h: tbH }, fn: () => this.cb.onBack() });

    // ── Story brief panel (briefKey) ─────────────────────────────────────────
    let y = tbH + Math.round(h * 0.02);
    if (this.cb.brief) {
      y = this.drawBrief(y);
    }

    // Materials strip.
    y += Math.round(h * 0.01);
    y = this.drawMaterials(y);

    // Upgrade list.
    const lbl = txt(t('prep.upgradesTitle'), Math.round(h * 0.026), C.dark, true);
    lbl.anchor.set(0, 0.5); lbl.x = Math.round(w * 0.08); lbl.y = y + Math.round(h * 0.02);
    this.container.addChild(lbl);
    y += Math.round(h * 0.05);

    const listX = Math.round(w * 0.06);
    const listW = w - listX * 2;
    const rowH = Math.round(h * 0.085);
    const gap = Math.round(h * 0.014);
    for (const def of PVE_UPGRADE_DEFS) {
      this.drawUpgradeRow(def, listX, y, listW, rowH);
      y += rowH + gap;
    }

    // Start button (bottom).
    const sbW = Math.round(w * 0.6);
    const sbH = Math.round(h * 0.08);
    const sbX = (w - sbW) / 2;
    const sbY = h - sbH - Math.round(h * 0.03);
    const sb = sketchPanel(sbW, sbH, { fill: C.dark, border: C.green, width: 2.6, seed: seedFor(sbX, sbY, sbW) });
    sb.x = sbX; sb.y = sbY;
    this.container.addChild(sb);
    const sl = txt(t('prep.start'), Math.round(sbH * 0.42), 0xffffff, true);
    sl.anchor.set(0.5, 0.5); sl.x = sbX + sbW / 2; sl.y = sbY + sbH / 2;
    this.container.addChild(sl);
    this.hits.push({ rect: { x: sbX, y: sbY, w: sbW, h: sbH }, fn: () => {
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
    } });

    if (this.toast) this.drawToast();
  }

  /** Owned-materials row; returns the y just below it. */
  private drawMaterials(y: number): number {
    const { w, h } = this;
    const mats = this.cb.getMaterials();
    const cellW = Math.round((w - Math.round(w * 0.12)) / MATERIAL_ORDER.length);
    const cellH = Math.round(h * 0.06);
    const startX = Math.round(w * 0.06);
    MATERIAL_ORDER.forEach((mat, i) => {
      const x = startX + i * cellW;
      const lbl = txt(`${t(('material.' + mat) as TranslationKey)} ${mats[mat] ?? 0}`,
        Math.round(cellH * 0.42), C.dark, true);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + cellW / 2; lbl.y = y + cellH / 2;
      this.container.addChild(lbl);
    });
    return y + cellH + Math.round(h * 0.02);
  }

  private drawUpgradeRow(def: PveUpgradeDef, x: number, y: number, w: number, h: number): void {
    const lvl = this.cb.getUpgradeLevel(def.id);
    const maxed = lvl >= def.maxLevel;
    const cost = upgradeCost(def, lvl);
    const owned = this.cb.getMaterials()[def.material] ?? 0;
    const affordable = cost !== null && owned >= cost.amount;

    const box = sketchPanel(w, h, { fill: C.paper, border: C.line, width: 1.6, seed: seedFor(x, y, w) });
    box.x = x; box.y = y;
    sketchAccentBar(box, h, C.accent, seedFor(x, h, 5));
    this.container.addChild(box);

    // "<Unit> · <stat>"
    const unitName = UNIT_NAME_KEY[def.unitType] ? t(UNIT_NAME_KEY[def.unitType]!) : def.unitType;
    const statName = t(('prep.stat.' + def.stat) as TranslationKey);
    const name = txt(`${unitName} · ${statName}`, Math.round(h * 0.26), C.dark, true);
    name.anchor.set(0, 0.5); name.x = x + Math.round(w * 0.04); name.y = y + h * 0.36;
    this.container.addChild(name);

    // Level + cost line.
    const lvlStr = t('prep.lv', { lv: lvl, max: def.maxLevel });
    const costStr = maxed
      ? t('prep.maxed')
      : `${t(('material.' + def.material) as TranslationKey)} ×${cost!.amount}`;
    const sub = txt(`${lvlStr}   ${costStr}`, Math.round(h * 0.22),
      maxed ? C.mid : (affordable ? C.gold : C.mid));
    sub.anchor.set(0, 0.5); sub.x = x + Math.round(w * 0.04); sub.y = y + h * 0.72;
    this.container.addChild(sub);

    // Upgrade button (right). Server-authoritative spend → disabled offline (§8).
    const online = this.cb.isOnline();
    const canAfford = !maxed && affordable;
    const enabled = canAfford && online; // 视觉可用：能买得起且在线
    const bw = Math.round(w * 0.22);
    const bh = Math.round(h * 0.6);
    const bx = x + w - bw - Math.round(w * 0.03);
    const by = y + (h - bh) / 2;
    const btn = sketchPanel(bw, bh, {
      fill: enabled ? C.dark : C.btnDis,
      border: enabled ? C.green : C.btnOff,
      width: 2, seed: seedFor(bx, by, bw),
    });
    btn.x = bx; btn.y = by;
    this.container.addChild(btn);
    const blabel = txt(maxed ? t('prep.maxed') : t('prep.upgrade'),
      Math.round(bh * 0.34), enabled ? 0xffffff : C.mid, true);
    blabel.anchor.set(0.5, 0.5); blabel.x = bx + bw / 2; blabel.y = by + bh / 2;
    this.container.addChild(blabel);

    // 仍买得起就接受点击：在线 → 升级；离线 → onUpgrade 弹「联网升级」提示。
    if (canAfford) {
      this.hits.push({ rect: { x: bx, y: by, w: bw, h: bh }, fn: () => this.onUpgrade(def) });
    }
  }

  /** Compact story-brief panel, returns the y just below it. */
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

    // Word-wrap to maxLines using a scratch Text for measurement.
    const scratch = txt(this.cb.brief!, fontSize, C.mid);
    scratch.style.wordWrap = true;
    scratch.style.wordWrapWidth = panW - Math.round(panW * 0.12);
    scratch.anchor.set(0, 0);
    scratch.x = padX + Math.round(panW * 0.06);
    scratch.y = y + Math.round(panH * 0.1);
    this.container.addChild(scratch);

    return y + panH + Math.round(h * 0.015);
  }

  /** Builds the IntroScene-style line-by-line intro overlay. Called from render() when showingIntro. */
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

    // Start fading in the first line.
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
