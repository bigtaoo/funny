// Overlay/modal domain: season-settlement modal (SE-6), first-time feature guide
// (ONBOARDING §4.1), and the transient achievement-unlock / info toast (S9-5b).
// All three are top-most layers added directly to `core.container` and torn down
// independently of the main build()/rebuild() layout. Clean leaf — never called back
// into by build.ts/badges.ts (confirmed via grep during the 2026-08-12 conversion).
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { buildIcon, IconKind } from '../../render/icons';
import { makeText } from '../../render/pixiText';
import { txtFit } from '../../render/sketchUi';
import { C, txt, sketchPanel, type LobbySceneCore } from './core';
import { snapFont } from '../../render/fontScale';
import { buildEntryNoticeStrip, type EntryNoticeSpec } from '../../ui/dialogs/EntryNoticeStrip';
import { UI_FONT_FAMILY } from '../../render/theme';

export class OverlaysPanel {
  constructor(private readonly core: LobbySceneCore) {}

  /** Show season-settlement modal (SE-6). Called once per season transition by the core. */
  showSeasonSettlement(oldNo: number, peakRank: string, newNo: number): void {
    const core = this.core;
    if (core.destroyed || core.settlementLayer) return;
    const { w, h } = core;
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

    const titleLbl = txt(t('season.settlement.title', { no: String(oldNo) }), snapFont(Math.round(ch * 0.13)), C.dark, true);
    titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(ch * 0.08);
    layer.addChild(titleLbl);

    const peakLbl = txt(t('season.settlement.peak'), snapFont(Math.round(ch * 0.1)), C.mid);
    peakLbl.anchor.set(0.5, 0); peakLbl.x = w / 2; peakLbl.y = cy + Math.round(ch * 0.27);
    layer.addChild(peakLbl);

    const peakVal = txt(peakRank, snapFont(Math.round(ch * 0.14)), C.gold, true);
    peakVal.anchor.set(0.5, 0); peakVal.x = w / 2; peakVal.y = cy + Math.round(ch * 0.38);
    layer.addChild(peakVal);

    const newSeasonLbl = txt(t('season.settlement.newSeason', { no: String(newNo) }), snapFont(Math.round(ch * 0.09)), C.accent);
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
    const btnLbl = txt(t('season.settlement.close'), snapFont(Math.round(btnH * 0.5)), 0xffffff, true);
    btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = btnY + btnH / 2;
    layer.addChild(btnLbl);

    core.container.addChild(layer);
    core.settlementLayer = layer;
    core.settlementDismissRect = { x: btnX, y: btnY, w: btnW, h: btnH };
  }

  clearSettlement(): void {
    const core = this.core;
    core.settlementDismissRect = null;
    if (core.settlementLayer) { core.settlementLayer.destroy({ children: true }); core.settlementLayer = null; }
  }

  /**
   * First-time feature guide card (ONBOARDING_DESIGN §4.1): dismissable overlay +
   * "Got it" button. onDismiss continues navigation after dismissal. Light-hint style
   * consistent with the tutorial — does not block the player from using the feature.
   */
  showFeatureGuide(titleKey: TranslationKey, bodyKey: TranslationKey, onDismiss: () => void): void {
    const core = this.core;
    if (core.destroyed || core.guideLayer) { onDismiss(); return; }
    const { w, h } = core;
    const layer = new PIXI.Container();

    const backdrop = new PIXI.Graphics();
    backdrop.beginFill(0x000000, 0.6).drawRect(0, 0, w, h).endFill();
    layer.addChild(backdrop);

    // Sizes come from a nominal card height; the real height grows to fit the wrapped body, so a
    // long translation on a narrow portrait screen pushes the button down instead of under it.
    const cw = Math.round(w * 0.8);
    const unit = Math.round(h * 0.34);
    const bodyLbl = wrappedBody(t(bodyKey), snapFont(Math.round(unit * 0.092)), cw);
    const btnW = Math.round(cw * 0.4);
    const btnH = Math.round(unit * 0.2);
    const bodyTop = Math.round(unit * 0.32);
    const ch = Math.max(unit, bodyTop + Math.ceil(bodyLbl.height) + Math.round(unit * 0.08) + btnH + Math.round(unit * 0.1));
    const cx = (w - cw) / 2;
    const cy = Math.round((h - ch) / 2);
    const card = sketchPanel(cw, ch, { fill: C.paper, border: C.accent, width: 2.6, seed: 91 });
    card.x = cx; card.y = cy;
    layer.addChild(card);

    const titleLbl = txt(t(titleKey), snapFont(Math.round(unit * 0.13)), C.dark, true);
    titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(unit * 0.1);
    layer.addChild(titleLbl);

    bodyLbl.x = w / 2; bodyLbl.y = cy + bodyTop;
    layer.addChild(bodyLbl);

    const btnX = (w - btnW) / 2;
    const btnY = cy + ch - btnH - Math.round(unit * 0.1);
    const btn = new PIXI.Graphics();
    btn.beginFill(C.dark).drawRoundedRect(btnX, btnY, btnW, btnH, Math.round(btnH * 0.3)).endFill();
    layer.addChild(btn);
    const btnLbl = txt(t('guide.gotIt'), snapFont(Math.round(btnH * 0.46)), 0xffffff, true);
    btnLbl.anchor.set(0.5, 0.5); btnLbl.x = w / 2; btnLbl.y = btnY + btnH / 2;
    layer.addChild(btnLbl);

    core.container.addChild(layer);
    core.guideLayer = layer;
    core.guideDismissRect = { x: cx, y: cy, w: cw, h: ch };
    core.guideOnDismiss = onDismiss;
  }

  /**
   * The consumption-data consent card (IOS_RELEASE.md §4.1b): a two-button question, unlike every
   * other overlay in this file, because "dismissed" is not an answer Apple accepts. Both buttons
   * answer; there is deliberately no way to close it without answering, and it is only ever shown
   * once (platform/appleConsumptionConsent.ts decides when).
   *
   * A card in the lobby rather than a row in Settings: that screen has no flow layout — every
   * section is a hand-tuned fraction of the viewport height, and its columns already run to 0.93h —
   * so a new row there would draw on top of a neighbour on some viewport nobody checked. This also
   * puts the question where the player will actually read it, once, instead of on a settings page
   * they may never open.
   */
  showConsumptionConsent(onAnswer: (consented: boolean) => void): void {
    const core = this.core;
    // Not while another overlay owns the screen. Drawing over the season-settlement modal would
    // stack two cards and take its taps (this one is added later and answered first), and the
    // settlement is a once-a-season moment the player is waiting for. The question is asked on the
    // next lobby entry instead — nothing about it is time-critical.
    if (core.destroyed || core.consentLayer || core.settlementLayer || core.guideLayer) return;
    const { w, h } = core;
    const layer = new PIXI.Container();

    const backdrop = new PIXI.Graphics();
    backdrop.beginFill(0x000000, 0.6).drawRect(0, 0, w, h).endFill();
    layer.addChild(backdrop);

    // Same grow-to-fit rule as the feature guide: this body is the longest text any lobby card
    // carries, and at a fixed height it ran under the buttons on a portrait phone.
    const cw = Math.round(w * 0.8);
    const unit = Math.round(h * 0.42);
    const bodyLbl = wrappedBody(t('iap.consentBody'), snapFont(Math.round(unit * 0.075)), cw);
    const btnH = Math.round(unit * 0.17);
    const bodyTop = Math.round(unit * 0.26);
    const ch = Math.max(unit, bodyTop + Math.ceil(bodyLbl.height) + Math.round(unit * 0.07) + btnH + Math.round(unit * 0.09));
    const cx = (w - cw) / 2;
    const cy = Math.round((h - ch) / 2);
    const card = sketchPanel(cw, ch, { fill: C.paper, border: C.accent, width: 2.6, seed: 137 });
    card.x = cx; card.y = cy;
    layer.addChild(card);

    const titleLbl = txtFit(t('iap.consentTitle'), snapFont(Math.round(unit * 0.11)), C.dark, true, cw - Math.round(cw * 0.08));
    titleLbl.anchor.set(0.5, 0); titleLbl.x = w / 2; titleLbl.y = cy + Math.round(unit * 0.08);
    layer.addChild(titleLbl);

    bodyLbl.x = w / 2; bodyLbl.y = cy + bodyTop;
    layer.addChild(bodyLbl);

    // Two buttons side by side, each 40% of the card: "Allow" carries the accent, "Not now" is
    // plain, and neither is pre-selected — the honest presentation of a question we must not lead.
    const btnW = Math.round(cw * 0.4);
    const gap = Math.round(cw * 0.04);
    const btnY = cy + ch - btnH - Math.round(unit * 0.09);
    const yesX = cx + cw / 2 - gap / 2 - btnW;
    const noX = cx + cw / 2 + gap / 2;

    const draw = (bx: number, fill: number, label: string, labelColor: number): void => {
      const btn = new PIXI.Graphics();
      btn.beginFill(fill).drawRoundedRect(bx, btnY, btnW, btnH, Math.round(btnH * 0.3)).endFill();
      layer.addChild(btn);
      const lbl = txtFit(label, snapFont(Math.round(btnH * 0.4)), labelColor, true, btnW - Math.round(btnW * 0.1));
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + btnW / 2; lbl.y = btnY + btnH / 2;
      layer.addChild(lbl);
    };
    draw(yesX, C.accent, t('iap.consentAllow'), 0xffffff);
    draw(noX, C.light, t('iap.consentDecline'), C.dark);

    core.container.addChild(layer);
    core.consentLayer = layer;
    core.consentYesRect = { x: yesX, y: btnY, w: btnW, h: btnH };
    core.consentNoRect = { x: noX, y: btnY, w: btnW, h: btnH };
    core.consentOnAnswer = onAnswer;
  }

  /**
   * The non-blocking Terms/Privacy notice + analytics prompt (IPlatform.entryNoticeOnly — the
   * CrazyGames build, COMPLIANCE_GLOBAL §3.3). A strip above the bottom nav that owns only its own
   * rectangle: build.ts routes taps inside it to the strip and lets every other tap through to the
   * lobby, so it never stands between the player and a button. A second call replaces the first.
   */
  showEntryNotice(spec: EntryNoticeSpec): void {
    const core = this.core;
    if (core.destroyed) return;
    this.clearEntryNotice();
    const navH = Math.round(core.h * 0.105); // drawBottomNav's bar height — the strip sits on top of it
    const built = buildEntryNoticeStrip(core.w, core.h, navH, spec, () => this.clearEntryNotice());
    core.container.addChild(built.container);
    core.noticeLayer = built.container;
    core.noticeRect = built.rect;
    core.noticeHits = built.hits;
  }

  clearEntryNotice(): void {
    const core = this.core;
    core.noticeRect = null;
    core.noticeHits = [];
    if (core.noticeLayer) { core.noticeLayer.destroy({ children: true }); core.noticeLayer = null; }
  }

  /** Tear the consent card down and report the answer (called by build.ts's tap routing). */
  answerConsumptionConsent(consented: boolean): void {
    const core = this.core;
    const cb = core.consentOnAnswer;
    core.consentOnAnswer = null;
    core.consentYesRect = null;
    core.consentNoRect = null;
    if (core.consentLayer) { core.consentLayer.destroy({ children: true }); core.consentLayer = null; }
    cb?.(consented);
  }

  clearGuide(): void {
    const core = this.core;
    core.guideDismissRect = null;
    const cb = core.guideOnDismiss;
    core.guideOnDismiss = null;
    if (core.guideLayer) { core.guideLayer.destroy({ children: true }); core.guideLayer = null; }
    cb?.();
  }

  /** Draw the toast banner near the top of the lobby (below the header), in its own top-most layer. */
  private drawAchievementToast(text: string, icon: IconKind = 'trophy'): void {
    const core = this.core;
    if (core.toastLayer) { core.toastLayer.destroy({ children: true }); core.toastLayer = null; }
    const { w, h } = core;
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
    const lbl = txt(text, snapFont(Math.round(bh * 0.34)), 0xffffff, true);
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

    core.container.addChild(layer); // top-most, above vsLayer
    core.toastLayer = layer;
    core.toastRect = { x: bx, y: by, w: bw, h: bh };
  }

  /**
   * Show a transient "achievement unlocked" toast banner (ACHIEVEMENT_DESIGN §7, S9-5b).
   * The core computes the unlock delta after a stats refresh and passes one aggregated
   * message (never one-per-tier); tapping the banner routes to the achievement wall.
   */
  showAchievementToast(text: string): void {
    const core = this.core;
    if (core.destroyed || !text) return;
    core.toastTimer = 4.0;
    this.drawAchievementToast(text);
  }

  /**
   * Generic info bubble (no tap routing). Used for SLG soft-gate prompts such as
   * "clear chapter one to unlock" (ONBOARDING §4). Reuses the achievement toast
   * banner + auto-fade, but leaves toastRect null → tapping does not navigate anywhere.
   */
  showInfoToast(text: string, icon: IconKind = 'globe'): void {
    const core = this.core;
    if (core.destroyed || !text) return;
    core.toastTimer = 3.0;
    this.drawAchievementToast(text, icon);
    core.toastRect = null;
  }

  clearToast(): void {
    const core = this.core;
    core.toastTimer = 0;
    core.toastRect = null;
    if (core.toastLayer) { core.toastLayer.destroy({ children: true }); core.toastLayer = null; }
  }
}

/** A card's wrapped body paragraph, anchored top-centre. */
function wrappedBody(text: string, fontSize: number, cardW: number): PIXI.Text {
  const lbl = makeText(text, {
    fontSize, fill: C.mid, fontFamily: UI_FONT_FAMILY, align: 'center',
    lineHeight: Math.round(fontSize * 1.4),
    wordWrap: true, wordWrapWidth: cardW - Math.round(cardW * 0.12), breakWords: true,
  });
  lbl.anchor.set(0.5, 0);
  return lbl;
}
