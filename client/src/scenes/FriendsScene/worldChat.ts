// World channel tab: the world-chat message list + input box + a single message row.
//
// WorldChatPanel depends on NetworkPanel (via NetworkHandlers — doSendWorldChat/loadWorldMessages/
// doAdd) but NetworkPanel has no dependency back on it: one-way, so a plain independent class over
// `core` + `network` (2026-08-11 converted from the former `XMixin(Base)` inheritance chain, per
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { snapFont } from '../../render/fontScale';
import { drawChatLine } from '../../ui/widgets/chatRow';
import type { WorldChatMessage } from '../../net/WorldApiClient';
import type { FriendsSceneCore } from './core';
import { addButton, caretText, centerLabel, centerLabelFixed, openHiddenInput, scrollRegion } from './chrome';
import type { NetworkHandlers } from './network';

export class WorldChatPanel {
  constructor(private readonly core: FriendsSceneCore, private readonly network: NetworkHandlers) {}

  // ── World channel tab ─────────────────────────────────────────────────────────

  drawWorldTab(): void {
    const core = this.core;
    const { w, h } = core;

    if (!core.cb.loadWorldChat) {
      core.regionTop = core.bodyTop + Math.round(h * 0.01);
      centerLabelFixed(core, t('social.noSlg'));
      return;
    }

    // Input area pinned at the bottom (stops clear of the portrait bottom nav bar, see bodyBottom)
    const inputH = Math.round(h * 0.1);
    const inputY = core.bodyBottom - inputH;
    const px = core.cX;
    const sendBtnW = Math.round(w * 0.24);
    const inputW = core.cW - sendBtnW - Math.round(w * 0.02);

    const inputBoxH = Math.round(inputH * 0.75);
    const inputBg = sketchPanel(inputW, inputBoxH, {
      fill: C.paper, border: core.worldChatActive ? C.accent : C.line, width: 2, seed: seedFor(px, inputY, inputW),
    });
    inputBg.x = px; inputBg.y = inputY + Math.round(inputH * 0.125);
    core.container.addChild(inputBg);
    const padX = Math.round(inputW * 0.04);
    // Clip to the input box (portrait's narrow inputW made a long line spill past the box and
    // over the send button, see git history) and, once the line overflows, anchor from the right
    // so the caret at the end stays visible while typing — same scroll behaviour a native text
    // input gives you. Re-applied on every string change, the caret blink's in-place swap included
    // (that's what `reflow` is for), since one caret glyph can tip the line over the threshold.
    const reflowInput = (obj: PIXI.Text): void => {
      if (obj.width > inputW - padX * 2) {
        obj.anchor.set(1, 0.5);
        obj.x = px + inputW - padX;
      } else {
        obj.anchor.set(0, 0.5);
        obj.x = px + padX;
      }
    };
    const inputTxt = caretText(core, {
      active: core.worldChatActive, value: core.worldChatInput,
      placeholder: t('social.world.placeholder'),
      size: snapFont(Math.round(inputH * 0.3)), color: core.worldChatInput ? C.dark : C.mid,
      reflow: reflowInput,
    });
    const inputClip = new PIXI.Graphics();
    inputClip.beginFill(0xffffff);
    inputClip.drawRect(px, inputBg.y, inputW, inputBoxH);
    inputClip.endFill();
    core.container.addChild(inputClip);
    inputTxt.mask = inputClip;
    reflowInput(inputTxt);
    inputTxt.y = inputY + inputH / 2;
    core.container.addChild(inputTxt);
    core.hits.push({ rect: { x: px, y: inputY, w: inputW, h: inputH }, fn: () => {
      core.worldChatActive = true;
      openHiddenInput(core, {
        value: core.worldChatInput, maxLength: 200,
        onInput: (v) => { core.worldChatInput = v; },
        onBlur: () => { core.worldChatActive = false; },
        onEnter: () => { void this.network.doSendWorldChat(); },
      });
      core.render();
    }});

    const sendLabel = core.worldSending ? t('social.world.sending') : t('social.world.sendBtn');
    const sendFill = core.worldSending ? C.btnOff : C.dark;
    addButton(core, sendLabel,
      px + inputW + Math.round(w * 0.02), inputY + Math.round(inputH * 0.125),
      sendBtnW, Math.round(inputH * 0.75), sendFill, C.gold,
      () => { if (!core.worldSending) void this.network.doSendWorldChat(); });

    // Message list above input
    core.regionTop = core.bodyTop + Math.round(h * 0.01);
    core.regionBottom = inputY - Math.round(h * 0.01);
    const regionH = core.regionBottom - core.regionTop;
    const { layer } = scrollRegion(core, regionH);

    if (core.worldLoadError) {
      const msgY = core.regionTop + regionH * 0.4;
      const msg = txt(t('social.world.loadFail'), snapFont(Math.round(h * 0.032)), C.mid);
      msg.anchor.set(0.5, 0.5); msg.x = core.cCX; msg.y = msgY;
      layer.addChild(msg);
      const btnW = Math.round(core.cW * 0.3);
      const btnH = Math.round(h * 0.05);
      addButton(core, t('friends.retry'),
        core.cCX - btnW / 2, msgY + Math.round(h * 0.05),
        btnW, btnH, C.dark, C.gold,
        () => { void this.network.loadWorldMessages(); }, 0xffffff, undefined, layer);
      core.maxScroll = 0;
      return;
    }
    if (!core.worldLoaded) {
      centerLabel(core, layer, 'friends.loading', regionH);
      core.maxScroll = 0;
      return;
    }
    if (core.worldMessages.length === 0) {
      centerLabel(core, layer, 'social.world.empty', regionH);
      core.maxScroll = 0;
      return;
    }

    const rh = Math.round(h * 0.06);
    const rowGap = Math.round(h * 0.01);
    const startCy = Math.round(h * 0.01);

    // Settle the scroll BEFORE placing rows (all rows are fixed-height, so the content height is
    // known up front): pin to the latest message unless the user scrolled up to read history.
    core.maxScroll = Math.max(0, startCy + core.worldMessages.length * (rh + rowGap) - regionH);
    if (core.worldStick) core.scrollY = core.maxScroll;
    else if (core.scrollY > core.maxScroll) core.scrollY = core.maxScroll;
    // scrollRegion() above baselined the layer at the pre-settle scrollY; rows below are placed at
    // the settled one, so re-baseline or the next drag would translate by that stale difference.
    core.repaint.markScrollBuilt();

    let cy = startCy;
    const screenY = (c: number) => core.regionTop + c - core.scrollY;
    for (const m of core.worldMessages) {
      const sy = screenY(cy);
      if (core.rowVisible(sy, rh)) this.drawWorldMsgRow(layer, m, sy);
      cy += rh + rowGap;
    }
  }

  private drawWorldMsgRow(layer: PIXI.Container, m: WorldChatMessage, y: number): void {
    const core = this.core;
    const { h } = core;
    const rh = Math.round(h * 0.06);
    const rx = core.cX;
    const rw = core.cW;
    const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.line, width: 1, seed: seedFor(rx, m.ts % 1000, rw) });
    bg.x = rx; bg.y = y;
    layer.addChild(bg);

    // Full-width row (unlike the Sect/Family split-view columns), so a message here has roughly
    // half again as much room before chatRow.ts has to truncate it.
    const inset = Math.round(rw * 0.04);
    drawChatLine(
      layer, rx + inset, y + rh / 2,
      { senderName: m.senderName, title: m.title, sectName: m.sectName, familyName: m.familyName },
      m.body, snapFont(Math.round(rh * 0.32)), snapFont(Math.round(rh * 0.32)), rw - inset * 2,
    );

    core.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openWorldSenderProfile(m) });
  }

  private openWorldSenderProfile(m: WorldChatMessage): void {
    const core = this.core;
    const isSelf = !!core.cb.myPublicId && m.senderPublicId === core.cb.myPublicId;
    const alreadyFriend = core.friends.some((f) => f.publicId === m.senderPublicId);
    core.popup.show({
      name: m.senderName,
      publicId: m.senderPublicId,
      isSelf,
      ...(m.title ? { equippedTitle: m.title } : {}),
      ...(!isSelf ? {
        actions: alreadyFriend
          ? [{ labelKey: 'friends.message', fn: () => core.cb.openChat(m.senderPublicId, m.senderName) }]
          : [{ labelKey: 'friends.add', fn: () => void this.network.doAdd(m.senderPublicId) }],
      } : {}),
    });
  }
}
