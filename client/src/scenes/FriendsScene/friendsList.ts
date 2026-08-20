// Friends tab: the friend/request list (drawList) + its rows + the friend profile popup entry.
//
// FriendsListPanel depends on NetworkPanel (via NetworkHandlers — doRespond/doDuelRespond/doDuel/
// doReport/doBlock/doRemove) and needs the Search tab's entry point (openSearch), but neither
// depends back on it: one-way, so a plain independent class over `core` + `network` + `openSearch`
// (2026-08-11 converted from the former `XMixin(Base)` inheritance chain, per
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t, TranslationKey } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS, snapFont } from '../../render/fontScale';
import type { FriendView, FriendRequestView } from '../../net/ApiClient';
import { buildAvatar } from '../../render/avatar';
import { rankLabel } from './core';
import type { FriendsSceneCore } from './core';
import { addButton, scrollRegion } from './chrome';
import type { NetworkHandlers } from './network';
import { serverNow } from '../../net/serverClock';

/** Narrow slice this panel needs to jump into the search subview (Search tab's own entry point). */
export interface SearchEntry {
  openSearch(): void;
}

export class FriendsListPanel {
  constructor(
    private readonly core: FriendsSceneCore,
    private readonly network: NetworkHandlers,
    private readonly search: SearchEntry
  ) {}

  // ── Friends tab ───────────────────────────────────────────────────────────────

  drawList(): void {
    const core = this.core;
    const { w, h } = core;
    const aY = core.bodyTop + Math.round(h * 0.01);
    const aH = Math.round(h * 0.075);
    const aGap = Math.round(w * 0.02);
    const aW = Math.round((core.cW - aGap) / 2);
    const aX0 = core.cX;
    addButton(core, t('friends.search'), aX0, aY, aW, aH, C.dark, C.accent, () => this.search.openSearch());
    addButton(core, t('friends.room'), aX0 + aW + aGap, aY, aW, aH, C.dark, C.gold, () => core.cb.onOpenRoom());

    core.regionTop = aY + aH + Math.round(h * 0.02);
    core.regionBottom = core.bodyBottom;
    const regionH = core.regionBottom - core.regionTop;
    // Shared helper rather than an inline clip+layer, so this list also registers as the render's
    // scroll layer and gets the cheap drag-translate path (see chrome.ts's scrollRegion).
    const { layer } = scrollRegion(core, regionH);

    if (core.loading) {
      const l = txt(t('friends.loading'), FS.title, C.mid);
      l.anchor.set(0.5, 0.5); l.x = core.cCX; l.y = core.regionTop + regionH / 2;
      layer.addChild(l);
      core.maxScroll = 0;
      return;
    }

    let cy = 0;
    const rowGap = Math.round(h * 0.014);
    const screenY = (contentY: number) => core.regionTop + contentY - core.scrollY;

    const sectionLabel = (key: TranslationKey, count?: number): void => {
      const label = txt(count !== undefined ? `${t(key)} (${count})` : t(key), FS.heading, C.mid, true);
      label.anchor.set(0, 0.5); label.x = core.cX; label.y = screenY(cy + Math.round(h * 0.018));
      layer.addChild(label);
      cy += Math.round(h * 0.045);
    };

    // Incoming duel invite banner — always first (60s response window, more time-sensitive
    // than friend requests, which have no expiry).
    if (core.incomingDuelInvite) {
      const dh = Math.round(h * 0.09);
      const sy = screenY(cy);
      if (core.rowVisible(sy, dh)) this.drawDuelInviteBanner(layer, core.incomingDuelInvite, sy, dh);
      cy += dh + rowGap + Math.round(h * 0.01);
    }

    if (core.incoming.length > 0) {
      sectionLabel('friends.requests', core.incoming.length);
      const reqH = Math.round(h * 0.09);
      for (const r of core.incoming) {
        const sy = screenY(cy);
        if (core.rowVisible(sy, reqH)) this.drawRequestRow(layer, r, cy, sy);
        cy += reqH + rowGap;
      }
      cy += Math.round(h * 0.01);
    }

    sectionLabel('friends.sectionFriends', core.friends.length);
    if (core.friends.length === 0) {
      const empty = txt(t('friends.empty'), FS.heading, C.mid);
      empty.anchor.set(0.5, 0); empty.x = core.cCX; empty.y = screenY(cy + Math.round(h * 0.02));
      layer.addChild(empty);
      cy += Math.round(h * 0.08);
    } else {
      const sorted = [...core.friends].sort(
        (a, b) => (a.online === b.online ? a.displayName.localeCompare(b.displayName) : a.online ? -1 : 1),
      );
      const fH = Math.round(h * 0.10);
      for (const f of sorted) {
        const sy = screenY(cy);
        if (core.rowVisible(sy, fH)) this.drawFriendRow(layer, f, cy, sy);
        cy += fH + rowGap;
      }
    }

    core.maxScroll = Math.max(0, cy - regionH);
    // Content height is only known once the rows are laid out, so a shrink (friend removed, request
    // answered) can only be clamped after the fact — rows above were already placed at the old
    // scrollY. Flag it so update() applies the difference next frame instead of leaving the view
    // silently out of sync with scrollY until the player happens to scroll again.
    if (core.scrollY > core.maxScroll) { core.scrollY = core.maxScroll; core.scrollDirty = true; }
  }

  private drawRequestRow(layer: PIXI.Container, r: FriendRequestView, _contentY: number, y: number): void {
    const core = this.core;
    const { h } = core;
    const rh = Math.round(h * 0.09);
    const rx = core.cX;
    const rw = core.cW;

    const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.gold, width: 2, seed: seedFor(rx, 0, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, C.gold, seedFor(rx, rh, 5));
    layer.addChild(bg);

    const name = txt(r.fromName || t('friends.you'), snapFont(Math.round(rh * 0.32)), C.dark, true);
    name.anchor.set(0, 0.5); name.x = rx + Math.round(rw * 0.06); name.y = y + rh * 0.36;
    layer.addChild(name);
    const id = txt(`#${r.fromPublicId}`, snapFont(Math.round(rh * 0.22)), C.mid);
    id.anchor.set(0, 0.5); id.x = rx + Math.round(rw * 0.06); id.y = y + rh * 0.70;
    layer.addChild(id);

    const bW = Math.round(rw * 0.18);
    const bH = Math.round(rh * 0.5);
    const bY = y + (rh - bH) / 2;
    const rejX = rx + rw - bW - Math.round(rw * 0.03);
    const accX = rejX - bW - Math.round(rw * 0.02);
    addButton(core, t('friends.accept'), accX, bY, bW, bH, C.green, C.green,
      () => void this.network.doRespond(r.requestId, true), 0xffffff, snapFont(Math.round(bH * 0.4)), layer);
    addButton(core, t('friends.reject'), rejX, bY, bW, bH, C.paper, C.red,
      () => void this.network.doRespond(r.requestId, false), C.red, snapFont(Math.round(bH * 0.4)), layer);
  }

  private drawDuelInviteBanner(
    layer: PIXI.Container,
    invite: { inviteId: string; fromPublicId: string; fromName: string; expiresAt: number },
    y: number, rh: number,
  ): void {
    const core = this.core;
    const rx = core.cX;
    const rw = core.cW;

    const bg = sketchPanel(rw, rh, { fill: C.paper, border: C.red, width: 2, seed: seedFor(rx, 3, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, C.red, seedFor(rx, rh, 9));
    layer.addChild(bg);

    const secsLeft = Math.max(0, Math.ceil((invite.expiresAt - serverNow()) / 1000));
    const label = txt(t('friends.duelInviteBanner', { name: invite.fromName || invite.fromPublicId, secs: secsLeft }),
      snapFont(Math.round(rh * 0.28)), C.dark, true);
    label.anchor.set(0, 0.5); label.x = rx + Math.round(rw * 0.06); label.y = y + rh * 0.5;
    layer.addChild(label);
    // Kept so the once-a-second countdown rewrites this one string (repaint.tickDuelBanner) instead
    // of rebuilding the whole tree.
    core.repaint.duelBannerLabel = label;

    const bW = Math.round(rw * 0.18);
    const bH = Math.round(rh * 0.5);
    const bY = y + (rh - bH) / 2;
    const rejX = rx + rw - bW - Math.round(rw * 0.03);
    const accX = rejX - bW - Math.round(rw * 0.02);
    addButton(core, t('friends.accept'), accX, bY, bW, bH, C.green, C.green,
      () => this.network.doDuelRespond(invite.inviteId, true), 0xffffff, snapFont(Math.round(bH * 0.4)), layer);
    addButton(core, t('friends.reject'), rejX, bY, bW, bH, C.paper, C.red,
      () => this.network.doDuelRespond(invite.inviteId, false), C.red, snapFont(Math.round(bH * 0.4)), layer);
  }

  private drawFriendRow(layer: PIXI.Container, f: FriendView, _contentY: number, y: number): void {
    const core = this.core;
    const { h } = core;
    const rh = Math.round(h * 0.10);
    const rx = core.cX;
    const rw = core.cW;
    const accent = f.online ? C.green : C.mid;

    const bg = sketchPanel(rw, rh, { fill: C.paper, border: accent, width: 2, seed: seedFor(rx, 1, rw) });
    bg.x = rx; bg.y = y;
    sketchAccentBar(bg, rh, accent, seedFor(rx, rh, 7));
    layer.addChild(bg);

    const avSize = Math.round(rh * 0.72);
    const avatar = buildAvatar(avSize, f.alias || f.displayName, seedFor(rx, 2, rw), f.avatarId);
    avatar.x = rx + Math.round(rw * 0.04); avatar.y = y + (rh - avSize) / 2;
    layer.addChild(avatar);

    const dot = new PIXI.Graphics();
    dot.beginFill(f.online ? C.green : C.btnOff);
    dot.lineStyle(1.5, C.paper);
    dot.drawCircle(0, 0, Math.round(rh * 0.08));
    dot.endFill();
    dot.x = rx + Math.round(rw * 0.04) + avSize; dot.y = y + (rh - avSize) / 2 + avSize;
    layer.addChild(dot);

    const tx = rx + Math.round(rw * 0.04) + avSize + Math.round(rw * 0.03);
    const name = txt(f.alias || f.displayName, snapFont(Math.round(rh * 0.30)), C.dark, true);
    name.anchor.set(0, 0.5); name.x = tx; name.y = y + rh * 0.34;
    layer.addChild(name);

    // Unread-chat bubble right of the name — this is what the bottom-nav Social dot was
    // counting; tap the row → profile popup → Message to read it.
    const unread = core.unreadChatFor(f.publicId);
    if (unread > 0) {
      const br = Math.round(rh * 0.15);
      const bx = tx + name.width + br + Math.round(rw * 0.025);
      const by = y + rh * 0.34;
      const bub = new PIXI.Graphics();
      bub.beginFill(C.red); bub.lineStyle(1.5, C.paper);
      bub.drawCircle(0, 0, br); bub.endFill();
      bub.x = bx; bub.y = by;
      layer.addChild(bub);
      const bl = txt(unread > 99 ? '99+' : String(unread), snapFont(Math.round(br * 1.1)), 0xffffff, true);
      bl.anchor.set(0.5, 0.5); bl.x = bx; bl.y = by;
      layer.addChild(bl);
    }

    const statusTxt = t(f.online ? 'friends.online' : 'friends.offline');
    const idRank = `#${f.publicId}${f.rank ? '  ·  ' + rankLabel(f.rank) : ''}  ·  ${statusTxt}`;
    const sub = txt(idRank, snapFont(Math.round(rh * 0.2)), C.mid);
    sub.anchor.set(0, 0.5); sub.x = tx; sub.y = y + rh * 0.68;
    layer.addChild(sub);

    const xW = Math.round(rh * 0.62);
    const xX = rx + rw - xW - Math.round(rw * 0.03);
    const xY = y + (rh - xW) / 2;
    addButton(core, '✕', xX, xY, xW, xW, C.paper, C.red,
      () => this.confirmRemove(f.publicId, f.alias || f.displayName), C.red, snapFont(Math.round(xW * 0.5)), layer);

    // Duel ("切磋", ADR friends-duel-confirm): offline friends can't receive a real-time invite, and
    // matchsvc only tracks one outstanding sent invite at a time — so ALL rows disable together while
    // any invite is in flight, not just the row it was sent to (that row's label just also changes).
    const duelSentHere = core.sendingDuelTo === f.publicId;
    const canDuel = f.online && core.sendingDuelTo === null;
    const duelW = Math.round(rh * 1.7);
    const duelH = Math.round(rh * 0.5);
    const duelX = xX - duelW - Math.round(rw * 0.02);
    const duelY = y + (rh - duelH) / 2;
    addButton(
      core,
      t(duelSentHere ? 'friends.duelSent' : 'friends.duel'), duelX, duelY, duelW, duelH,
      canDuel ? C.dark : C.btnOff, canDuel ? C.gold : C.light,
      canDuel ? () => this.network.doDuel(f.publicId) : () => {},
      canDuel ? 0xffffff : C.mid, snapFont(Math.round(duelH * 0.42)), layer,
    );

    core.hits.push({ rect: { x: rx, y, w: rw, h: rh }, scroll: true, fn: () => this.openFriendProfile(f) });
  }

  /** Removing a friend is a one-click ✕ tap away from the row — a stray tap used to delete
   *  immediately with no way back, so confirm first (reuses the shared OK/Cancel modal). */
  private confirmRemove(publicId: string, name: string): void {
    const core = this.core;
    core.showConfirm(t('friends.confirmRemove', { name }), () => {
      core.closeModal();
      void this.network.doRemove(publicId);
    });
  }

  private openFriendProfile(f: FriendView): void {
    const core = this.core;
    core.popup.show({
      name: f.alias || f.displayName,
      publicId: f.publicId,
      ...(f.avatarId ? { avatarId: f.avatarId } : {}),
      actions: [
        { labelKey: 'friends.message', fn: () => core.cb.openChat(f.publicId, f.alias || f.displayName) },
        { labelKey: 'friends.report', fn: () => void this.network.doReport(f.publicId), danger: true },
        { labelKey: 'friends.block', fn: () => void this.network.doBlock(f.publicId), danger: true },
      ],
    });
  }
}
