// Overlay/modal domain: season-settlement modal (SE-6), first-time feature guide
// (ONBOARDING §4.1), and the transient achievement-unlock / info toast (S9-5b).
// All three are top-most layers added directly to `this.container` and torn down
// independently of the main build()/rebuild() layout.
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { buildIcon, IconKind } from '../../render/icons';
import { C, txt, sketchPanel, type Constructor, type LobbySceneBaseCtor } from './base';

export interface OverlaysHandlers {
  showSeasonSettlement(oldNo: number, peakRank: string, newNo: number): void;
  showFeatureGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void;
  showAchievementToast(text: string): void;
  showInfoToast(text: string, icon?: IconKind): void;
  clearGuide(): void;
  clearSettlement(): void;
  clearToast(): void;
}

export function OverlaysMixin<TBase extends LobbySceneBaseCtor>(Base: TBase): TBase & Constructor<OverlaysHandlers> {
  return class extends Base {
    /** Show season-settlement modal (SE-6). Called once per season transition by the core. */
    showSeasonSettlement(oldNo: number, peakRank: string, newNo: number): void {
      if (this.destroyed || this.settlementLayer) return;
      const { w, h } = this;
      const layer = new PIXI.Container();

      // Dim backdrop
      const backdrop = new PIXI.Graphics();
      backdrop.beginFill(0x000000, 0.6).drawRect(0, 0, w, h).endFill();
      layer.addChild(backdrop);

      // Card
      const cw = Math.round(w * 0.78);
      const ch = Math.round(h * 0.44);
      const cx = (w - cw) / 2;
      const cy = (h - ch) / 2;
      const card = new PIXI.Graphics();
      card.lineStyle(2, C.gold, 1);
      card.beginFill(C.paper).drawRoundedRect(cx, cy, cw, ch, 12).endFill();
      layer.addChild(card);

      const titleLbl = txt(t('season.settlement.title', { no: String(oldNo) }), Math.round(ch * 0.13), C.dark, true);
      titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(ch * 0.08);
      layer.addChild(titleLbl);

      const peakLbl = txt(t('season.settlement.peak'), Math.round(ch * 0.1), C.mid);
      peakLbl.anchor.set(0.5, 0); peakLbl.x = w / 2; peakLbl.y = cy + Math.round(ch * 0.27);
      layer.addChild(peakLbl);

      const peakVal = txt(peakRank, Math.round(ch * 0.14), C.gold, true);
      peakVal.anchor.set(0.5, 0); peakVal.x = w / 2; peakVal.y = cy + Math.round(ch * 0.38);
      layer.addChild(peakVal);

      const newSeasonLbl = txt(t('season.settlement.newSeason', { no: String(newNo) }), Math.round(ch * 0.09), C.accent);
      newSeasonLbl.anchor.set(0.5, 0); newSeasonLbl.x = w / 2; newSeasonLbl.y = cy + Math.round(ch * 0.56);
      layer.addChild(newSeasonLbl);

      // Dismiss button
      const btnH = Math.round(ch * 0.16);
      const btnW = Math.round(cw * 0.5);
      const btnX = (w - btnW) / 2;
      const btnY = cy + Math.round(ch * 0.76);
      const btn = new PIXI.Graphics();
      btn.beginFill(C.dark).drawRoundedRect(btnX, btnY, btnW, btnH, Math.round(btnH * 0.3)).endFill();
      layer.addChild(btn);
      const btnLbl = txt(t('season.settlement.close'), Math.round(btnH * 0.5), 0xffffff, true);
      btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = btnY + btnH / 2;
      layer.addChild(btnLbl);

      this.container.addChild(layer);
      this.settlementLayer = layer;
      this.settlementDismissRect = { x: btnX, y: btnY, w: btnW, h: btnH };
    }

    clearSettlement(): void {
      this.settlementDismissRect = null;
      if (this.settlementLayer) { this.settlementLayer.destroy({ children: true }); this.settlementLayer = null; }
    }

    /**
     * First-time feature guide card (ONBOARDING_DESIGN §4.1): dismissable overlay +
     * "Got it" button. onDismiss continues navigation after dismissal. Light-hint style
     * consistent with the tutorial — does not block the player from using the feature.
     */
    showFeatureGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void {
      if (this.destroyed || this.guideLayer) { onDismiss(); return; }
      const { w, h } = this;
      const layer = new PIXI.Container();

      const backdrop = new PIXI.Graphics();
      backdrop.beginFill(0x000000, 0.6).drawRect(0, 0, w, h).endFill();
      layer.addChild(backdrop);

      const cw = Math.round(w * 0.8);
      const ch = Math.round(h * 0.34);
      const cx = (w - cw) / 2;
      const cy = (h - ch) / 2;
      const card = sketchPanel(cw, ch, { fill: C.paper, border: C.accent, width: 2.6, seed: 91 });
      card.x = cx; card.y = cy;
      layer.addChild(card);

      const titleLbl = txt(t(titleKey), Math.round(ch * 0.13), C.dark, true);
      titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(ch * 0.1);
      layer.addChild(titleLbl);

      const bodyLbl = new PIXI.Text(t(bodyKey), {
        fontSize: Math.round(ch * 0.092), fill: C.mid, fontFamily: 'monospace',
        wordWrap: true, wordWrapWidth: cw - Math.round(cw * 0.12), align: 'center',
      });
      bodyLbl.anchor.set(0.5, 0); bodyLbl.x = w / 2; bodyLbl.y = cy + Math.round(ch * 0.32);
      layer.addChild(bodyLbl);

      const btnW = Math.round(cw * 0.4);
      const btnH = Math.round(ch * 0.2);
      const btnX = (w - btnW) / 2;
      const btnY = cy + ch - btnH - Math.round(ch * 0.1);
      const btn = new PIXI.Graphics();
      btn.beginFill(C.dark).drawRoundedRect(btnX, btnY, btnW, btnH, Math.round(btnH * 0.3)).endFill();
      layer.addChild(btn);
      const btnLbl = txt(t('guide.gotIt'), Math.round(btnH * 0.46), 0xffffff, true);
      btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = btnY + btnH / 2;
      layer.addChild(btnLbl);

      this.container.addChild(layer);
      this.guideLayer = layer;
      this.guideDismissRect = { x: cx, y: cy, w: cw, h: ch };
      this.guideOnDismiss = onDismiss;
    }

    clearGuide(): void {
      this.guideDismissRect = null;
      const cb = this.guideOnDismiss;
      this.guideOnDismiss = null;
      if (this.guideLayer) { this.guideLayer.destroy({ children: true }); this.guideLayer = null; }
      cb?.();
    }

    /** Draw the toast banner near the top of the lobby (below the header), in its own top-most layer. */
    private drawAchievementToast(text: string, icon: IconKind = 'trophy'): void {
      if (this.toastLayer) { this.toastLayer.destroy({ children: true }); this.toastLayer = null; }
      const { w, h } = this;
      const layer = new PIXI.Container();
      const bw = Math.round(w * 0.82);
      const bh = Math.round(h * 0.072);
      const bx = (w - bw) / 2;
      const by = Math.round(h * 0.165);

      const box = new PIXI.Graphics();
      box.beginFill(C.dark, 0.95);
      box.lineStyle(2, C.gold, 0.95);
      box.drawRoundedRect(bx, by, bw, bh, Math.round(bh * 0.28));
      box.endFill();
      layer.addChild(box);

      // Hand-drawn trophy icon + label, centred as a group (replaces the 🏆 glyph).
      const ti = Math.round(bh * 0.58);
      const gap = Math.round(bh * 0.2);
      const lbl = txt(text, Math.round(bh * 0.34), 0xffffff, true);
      lbl.anchor.set(0, 0.5);
      const maxLblW = bw * 0.92 - ti - gap;
      if (lbl.width > maxLblW) lbl.scale.set(maxLblW / lbl.width);
      const total = ti + gap + lbl.width;
      const left = (w - total) / 2;

      const trophy = buildIcon(icon, ti, C.gold);
      trophy.x = Math.round(left); trophy.y = Math.round(by + bh / 2 - ti / 2);
      layer.addChild(trophy);
      lbl.x = left + ti + gap; lbl.y = by + bh / 2;
      layer.addChild(lbl);

      this.container.addChild(layer); // top-most, above vsLayer
      this.toastLayer = layer;
      this.toastRect = { x: bx, y: by, w: bw, h: bh };
    }

    /**
     * Show a transient "achievement unlocked" toast banner (ACHIEVEMENT_DESIGN §7, S9-5b).
     * The core computes the unlock delta after a stats refresh and passes one aggregated
     * message (never one-per-tier); tapping the banner routes to the achievement wall.
     */
    showAchievementToast(text: string): void {
      if (this.destroyed || !text) return;
      this.toastTimer = 4.0;
      this.drawAchievementToast(text);
    }

    /**
     * Generic info bubble (no tap routing). Used for SLG soft-gate prompts such as
     * "clear chapter one to unlock" (ONBOARDING §4). Reuses the achievement toast
     * banner + auto-fade, but leaves toastRect null → tapping does not navigate anywhere.
     */
    showInfoToast(text: string, icon: IconKind = 'globe'): void {
      if (this.destroyed || !text) return;
      this.toastTimer = 3.0;
      this.drawAchievementToast(text, icon);
      this.toastRect = null;
    }

    clearToast(): void {
      this.toastTimer = 0;
      this.toastRect = null;
      if (this.toastLayer) { this.toastLayer.destroy({ children: true }); this.toastLayer = null; }
    }
  };
}
