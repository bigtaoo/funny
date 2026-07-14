// World channel tab: the world-chat message list + input box + a single message row.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { caretDisplay } from '../../render/inputDisplay';
import type { WorldChatMessage } from '../../net/WorldApiClient';
import { type Constructor, type FriendsSceneBaseCtor } from './base';

export interface WorldChatHandlers {
  drawWorldTab(): void;
}

export function WorldChatMixin<TBase extends FriendsSceneBaseCtor>(Base: TBase): TBase & Constructor<WorldChatHandlers> {
  return class extends Base {
    // ── World channel tab ─────────────────────────────────────────────────────────

    drawWorldTab(): void {
      const { w, h } = this;

      if (!this.cb.loadWorldChat) {
        this.regionTop = this.bodyTop + Math.round(h * 0.01);
        this.centerLabelFixed(t('social.noSlg'));
        return;
      }

      // Input area pinned at the bottom
      const inputH = Math.round(h * 0.1);
      const inputY = h - inputH - Math.round(h * 0.01);
      const px = this.cX;
      const sendBtnW = Math.round(w * 0.24);
      const inputW = this.cW - sendBtnW - Math.round(w * 0.02);

      const inputBg = sketchPanel(inputW, Math.round(inputH * 0.75), {
        fill: C.paper, border: this.worldChatActive ? C.accent : C.line, width: 2, seed: seedFor(px, inputY, inputW),
      });
      inputBg.x = px; inputBg.y = inputY + Math.round(inputH * 0.125);
      this.container.addChild(inputBg);
      const inputTxt = txt(
        caretDisplay(this.worldChatInput, this.worldChatActive && this.caretOn, t('social.world.placeholder')),
        Math.round(inputH * 0.3),
        this.worldChatInput ? C.dark : C.mid,
      );
      inputTxt.anchor.set(0, 0.5);
      inputTxt.x = px + Math.round(inputW * 0.04);
      inputTxt.y = inputY + inputH / 2;
      this.container.addChild(inputTxt);
      this.hits.push({ rect: { x: px, y: inputY, w: inputW, h: inputH }, fn: () => {
        this.worldChatActive = true;
        this.openHiddenInput({
          value: this.worldChatInput, maxLength: 200,
          onInput: (v) => { this.worldChatInput = v; },
          onBlur: () => { this.worldChatActive = false; },
          onEnter: () => { void this.doSendWorldChat(); },
        });
        this.render();
      }});

      const sendLabel = this.worldSending ? t('social.world.sending') : t('social.world.sendBtn');
      const sendFill = this.worldSending ? C.btnOff : C.dark;
      this.addButton(sendLabel,
        px + inputW + Math.round(w * 0.02), inputY + Math.round(inputH * 0.125),
        sendBtnW, Math.round(inputH * 0.75), sendFill, C.gold,
        () => { if (!this.worldSending) void this.doSendWorldChat(); });

      // Message list above input
      this.regionTop = this.bodyTop + Math.round(h * 0.01);
      this.regionBottom = inputY - Math.round(h * 0.01);
      const regionH = this.regionBottom - this.regionTop;
      const { layer } = this.scrollRegion(regionH);

      if (!this.worldLoaded) {
        this.centerLabel(layer, 'friends.loading', regionH);
        this.maxScroll = 0;
        return;
      }
      if (this.worldMessages.length === 0) {
        this.centerLabel(layer, 'social.world.empty', regionH);
        this.maxScroll = 0;
        return;
      }

      const rh = Math.round(h * 0.095);
      const rowGap = Math.round(h * 0.01);
      let cy = Math.round(h * 0.01);
      const screenY = (c: number) => this.regionTop + c - this.scrollY;

      for (const m of this.worldMessages) {
        const sy = screenY(cy);
        if (this.rowVisible(sy, rh)) this.drawWorldMsgRow(layer, m, sy);
        cy += rh + rowGap;
      }
      this.maxScroll = Math.max(0, cy - regionH);
      // Auto-scroll to bottom on first load
      if (this.scrollY === 0 && this.maxScroll > 0) this.scrollY = this.maxScroll;
      if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;
    }

    private drawWorldMsgRow(layer: PIXI.Container, m: WorldChatMessage, y: number): void {
      const { h } = this;
      const rh = Math.round(h * 0.095);
      const rx = this.cX;
      const rw = this.cW;
      const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.line, width: 1, seed: seedFor(rx, m.ts % 1000, rw) });
      bg.x = rx; bg.y = y;
      layer.addChild(bg);

      const sender = txt(m.senderName, Math.round(rh * 0.28), C.accent, true);
      sender.anchor.set(0, 0.5); sender.x = rx + Math.round(rw * 0.04); sender.y = y + rh * 0.32;
      layer.addChild(sender);

      const body = txt(m.body.slice(0, 60), Math.round(rh * 0.26), C.dark);
      body.anchor.set(0, 0.5); body.x = rx + Math.round(rw * 0.04); body.y = y + rh * 0.68;
      layer.addChild(body);

      this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openWorldSenderProfile(m) });
    }

    private openWorldSenderProfile(m: WorldChatMessage): void {
      this.popup.show({ name: m.senderName, publicId: m.senderPublicId });
    }
  };
}
