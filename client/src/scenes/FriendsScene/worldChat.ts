// World channel tab: the world-chat message list + input box + a single message row.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { caretDisplay } from '../../render/inputDisplay';
import { drawChatLine } from '../../render/chatRow';
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
        snapFont(Math.round(inputH * 0.3)),
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

      if (this.worldLoadError) {
        const msgY = this.regionTop + regionH * 0.4;
        const msg = txt(t('social.world.loadFail'), snapFont(Math.round(h * 0.032)), C.mid);
        msg.anchor.set(0.5, 0.5); msg.x = this.cCX; msg.y = msgY;
        layer.addChild(msg);
        const btnW = Math.round(this.cW * 0.3);
        const btnH = Math.round(h * 0.05);
        this.addButton(t('friends.retry'),
          this.cCX - btnW / 2, msgY + Math.round(h * 0.05),
          btnW, btnH, C.dark, C.gold,
          () => { void this.loadWorldMessages(); }, 0xffffff, undefined, layer);
        this.maxScroll = 0;
        return;
      }
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

      const rh = Math.round(h * 0.06);
      const rowGap = Math.round(h * 0.01);
      const startCy = Math.round(h * 0.01);

      // Settle the scroll BEFORE placing rows (all rows are fixed-height, so the content height is
      // known up front): pin to the latest message unless the user scrolled up to read history.
      this.maxScroll = Math.max(0, startCy + this.worldMessages.length * (rh + rowGap) - regionH);
      if (this.worldStick) this.scrollY = this.maxScroll;
      else if (this.scrollY > this.maxScroll) this.scrollY = this.maxScroll;

      let cy = startCy;
      const screenY = (c: number) => this.regionTop + c - this.scrollY;
      for (const m of this.worldMessages) {
        const sy = screenY(cy);
        if (this.rowVisible(sy, rh)) this.drawWorldMsgRow(layer, m, sy);
        cy += rh + rowGap;
      }
    }

    private drawWorldMsgRow(layer: PIXI.Container, m: WorldChatMessage, y: number): void {
      const { h } = this;
      const rh = Math.round(h * 0.06);
      const rx = this.cX;
      const rw = this.cW;
      const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.line, width: 1, seed: seedFor(rx, m.ts % 1000, rw) });
      bg.x = rx; bg.y = y;
      layer.addChild(bg);

      drawChatLine(
        layer, rx + Math.round(rw * 0.04), y + rh / 2,
        { senderName: m.senderName, title: m.title, sectName: m.sectName, familyName: m.familyName },
        m.body, snapFont(Math.round(rh * 0.32)), snapFont(Math.round(rh * 0.32)),
      );

      this.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openWorldSenderProfile(m) });
    }

    private openWorldSenderProfile(m: WorldChatMessage): void {
      const isSelf = !!this.cb.myPublicId && m.senderPublicId === this.cb.myPublicId;
      const alreadyFriend = this.friends.some((f) => f.publicId === m.senderPublicId);
      this.popup.show({
        name: m.senderName,
        publicId: m.senderPublicId,
        isSelf,
        ...(m.title ? { equippedTitle: m.title } : {}),
        ...(!isSelf ? {
          actions: alreadyFriend
            ? [{ labelKey: 'friends.message', fn: () => this.cb.openChat(m.senderPublicId, m.senderName) }]
            : [{ labelKey: 'friends.add', fn: () => void this.doAdd(m.senderPublicId) }],
        } : {}),
      });
    }
  };
}
