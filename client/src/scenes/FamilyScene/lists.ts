// Roster + channel-message column rendering — split out of render.ts (2026-08-11, form ① independent
// function module per claudedocs/client-modules.md's split-form priority note) purely to keep
// render.ts under the 500-line convention. Only ever called from RenderPanel's own
// renderMembers/renderChannel delegate methods, so these take `core` explicitly instead of becoming
// their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { scrollRegionLayer } from '../../ui/widgets/scrollRegionLayer';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { buildAvatar } from '../../render/avatar';
import { caretText } from './repaint';
import { drawChatLine } from '../../ui/widgets/chatRow';
import { FS } from '../../render/fontScale';
import { FAMILY_CAP } from '@nw/shared';
import type { FamilySceneCore } from './core';

/** Darker muted ink for secondary family-scene labels — matches RenderPanel's MUTED. */
export const MUTED = 0x5a574f;

/** Re-instantiates `txt()` with progressively shorter text (ellipsis) until it fits `maxW`. Narrow
 *  portrait widths + a long family name would otherwise run the name into the member-count label.
 *  Exported for RenderPanel's renderInfoBand, which needs the same fit-to-width truncation. */
export function truncateToWidth(label: string, size: number, color: number, maxW: number): PIXI.Text {
  let s = label;
  let node = txt(s, size, color);
  while (node.width > maxW && s.length > 1) {
    node.destroy();
    s = s.slice(0, -1);
    node = txt(s + '…', size, color);
  }
  return node;
}

/** Narrow slice of ActionsHandlers that renderMembers needs. */
export interface MemberActions {
  confirmKick(targetId: string, name: string): void;
  doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void>;
  confirmDissolve(): void;
  confirmLeave(): void;
}

/** Roster column. `x0`/`colW` let this render either full-width (portrait tab) or as the
 *  left half of the landscape split view; `scrollKey` picks which scroll field this
 *  instance owns so the two columns can scroll independently in the split view. */
export function renderMembers(
  core: FamilySceneCore,
  actions: MemberActions,
  x0: number,
  colW: number,
  y0: number,
  maxH: number,
  scrollKey: 'scrollY' | 'scrollYChannel'
): void {
  const right = x0 + colW;
  const me = core.cb.myAccountId;
  const R = core.rowH;

  const myRole = core.members.find(m => m.accountId === me)?.role ?? 'member';
  const isLeader = myRole === 'leader';

  const listH = core.members.length * R;
  // Clamp the viewport so it always cuts mid-row when there's more below — a partial next
  // member card peeks above the fold instead of the row grid landing flush with the edge.
  const viewH = peekViewportH(maxH, R, listH);
  core.membersMax = Math.max(0, listH - viewH);
  core.membersRegionTop = y0;
  core.membersRegionBottom = y0 + viewH;
  core[scrollKey] = Math.max(0, Math.min(core[scrollKey], core.membersMax));

  // Rows go into a masked layer built one viewport beyond the fold in each direction (`over`), so a
  // drag inside that band just translates the layer instead of rebuilding every hand-drawn member
  // card — see ./repaint.ts. The mask is a sibling, not a child, so it stays put while the layer
  // moves under it. (Before this the roster drew straight onto bodyLayer with no mask at all, which
  // is also why a row straddling the bottom edge used to bleed past the viewport unclipped.)
  const { layer: list } = scrollRegionLayer(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH });
  const over = viewH;

  const btnH = Math.round(R * 0.44);
  // Buttons are sized to their (i18n-variable-length) label + padding rather than a fixed width,
  // so "Promote to Elder" / "Demote to Member" no longer clip the way a fixed box would.
  const padX = Math.round(core.h * 0.014);
  const btnGap = Math.round(core.h * 0.01);
  const busy = core.bt.busy;

  let cy = y0 - core[scrollKey];
  for (const mem of core.members) {
    if (cy + R < y0 - over || cy > y0 + viewH + over) { cy += R; continue; }
    const isMe = mem.accountId === me;

    // Per-member card background — my own row is tinted a touch warmer so it stands out.
    const rowBg = sketchPanel(colW - 12, R - 4, { fill: isMe ? 0xefe9d8 : 0xf7f5ee, border: C.mid, seed: seedFor(cy, 5, colW) });
    rowBg.x = x0 + 6; rowBg.y = cy + 2;
    list.addChild(rowBg);

    const bar = new PIXI.Graphics();
    sketchAccentBar(bar, R - 4, mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : C.mid);
    bar.x = x0 + 6; bar.y = cy + 2;
    list.addChild(bar);

    // Right-edge buttons, laid out from the right inward, built first so the name can be
    // truncated to stop before them. For other members (when I'm leader): kick + role toggle.
    // For my own row: the Leave / Dissolve action (see below), so it sits at the far right of
    // my name — replacing the old bottom bar.
    const showActions = isLeader && !isMe;
    const btnY = cy + Math.round((R - btnH) / 2);
    let nameRight = right - 12; // where the name column must stop

    if (showActions) {
      // accountId is always present here: this scene only ever renders the caller's OWN family
      // (getMyFamily / getFamily(ownFamilyId)), where the server always includes it.
      const accId = mem.accountId!;

      // Members holding an office (elder) can't be kicked directly — the button is greyed
      // out and clicking it just explains that the office must be resigned first, rather
      // than silently doing nothing or letting an elder be kicked with an armed officer role.
      // busy (a mutation in flight) greys it the same way, regardless of office.
      const hasOffice = mem.role === 'elder';
      const kickColor = busy ? MUTED : hasOffice ? MUTED : C.red;
      const kl = txt(t('family.kick'), FS.bodyLg, kickColor);
      const kickW = Math.round(kl.width + padX * 2);
      const kx = right - kickW - 8;
      const kickBtn = sketchPanel(kickW, btnH, { fill: hasOffice || busy ? 0xeceae2 : 0xf0e0e0, border: busy ? C.mid : hasOffice ? C.mid : C.red, seed: seedFor(cy, 0, kickW) });
      kickBtn.x = kx; kickBtn.y = btnY;
      list.addChild(kickBtn);
      kl.anchor.set(0.5, 0.5); kl.x = kx + kickW / 2; kl.y = btnY + btnH / 2;
      list.addChild(kl);
      if (!busy) {
        core.hitRects.push({
          rect: { x: kx, y: btnY, w: kickW, h: btnH },
          action: () => hasOffice
            ? core.showToast(t('family.kick.needDemoteFirst'), C.dark)
            : actions.confirmKick(accId, mem.displayName ?? mem.publicId ?? ''),
          scroll: 'members',
        });
      }
      nameRight = kx - btnGap;

      // Role toggle: members → elder, elders → member. (Leader role only changes via transfer/dissolve.)
      if (mem.role !== 'leader') {
        const toElder = mem.role === 'member';
        const roleColor = busy ? C.mid : 0xa9750f;
        const rl = txt(t(toElder ? 'family.setElder' : 'family.setMember'), FS.bodyLg, roleColor);
        const roleW = Math.round(rl.width + padX * 2);
        const bx = kx - btnGap - roleW;
        const roleBtn = sketchPanel(roleW, btnH, { fill: 0xeef0e0, border: busy ? C.mid : 0xd4a030, seed: seedFor(cy, 2, roleW) });
        roleBtn.x = bx; roleBtn.y = btnY;
        list.addChild(roleBtn);
        rl.anchor.set(0.5, 0.5); rl.x = bx + roleW / 2; rl.y = btnY + btnH / 2;
        list.addChild(rl);
        const nextRole: 'elder' | 'member' = toElder ? 'elder' : 'member';
        if (!busy) core.hitRects.push({ rect: { x: bx, y: btnY, w: roleW, h: btnH }, action: () => void actions.doSetRole(accId, nextRole), scroll: 'members' });
        nameRight = bx - btnGap;
      }
    } else if (isMe) {
      // Leave / Dissolve on my own row. A leader may only Dissolve, and only once they are the
      // sole member — while others remain they can neither leave nor dissolve (must transfer or
      // kick first). Everyone else gets Leave Family.
      const alone = core.members.length === 1;
      if (!isLeader || alone) {
        const dissolve = isLeader && alone;
        const leaveColor = busy ? C.mid : dissolve ? C.red : C.accent;
        const al = txt(t(dissolve ? 'family.dissolve' : 'family.leave'), FS.bodyLg, leaveColor);
        const aw = Math.round(al.width + padX * 2);
        const ax = right - aw - 8;
        const aBtn = sketchPanel(aw, btnH, { fill: 0xf8f8f0, border: leaveColor, seed: seedFor(cy, 3, aw) });
        aBtn.x = ax; aBtn.y = btnY;
        list.addChild(aBtn);
        al.anchor.set(0.5, 0.5); al.x = ax + aw / 2; al.y = btnY + btnH / 2;
        list.addChild(al);
        if (!busy) core.hitRects.push({ rect: { x: ax, y: btnY, w: aw, h: btnH }, action: () => dissolve ? actions.confirmDissolve() : actions.confirmLeave(), scroll: 'members' });
        nameRight = ax - btnGap;
      }
    }

    // Avatar, then name on the left, with the role label immediately to its right (was stacked above it).
    const avSize = Math.round((R - 4) * 0.7);
    const avatar = buildAvatar(avSize, mem.displayName ?? mem.publicId ?? '', seedFor(cy, 6, avSize), mem.avatarId);
    avatar.x = x0 + 12; avatar.y = cy + Math.round((R - avSize) / 2);
    list.addChild(avatar);

    const roleColor = mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : MUTED;
    const roleLbl = txt(t(`family.${mem.role as 'leader' | 'member' | 'elder'}`), FS.bodyLg, roleColor);
    const nameX = x0 + 18 + avSize + 8;
    const nameMaxW = Math.max(40, nameRight - nameX - roleLbl.width - 10);
    const nameLbl = truncateToWidth(mem.displayName ?? mem.publicId ?? '', FS.heading, C.dark, nameMaxW);
    nameLbl.x = nameX; nameLbl.y = cy + Math.round((R - nameLbl.height) / 2);
    list.addChild(nameLbl);
    roleLbl.x = nameLbl.x + nameLbl.width + 10; roleLbl.y = cy + Math.round((R - roleLbl.height) / 2);
    list.addChild(roleLbl);

    // Tapping the name/role opens the unified profile popup (view info + Add Friend).
    core.hitRects.push({
      rect: { x: x0 + 6, y: cy + 2, w: roleLbl.x + roleLbl.width - (x0 + 6), h: R - 4 },
      action: () => core.openMemberProfile(mem),
      scroll: 'members',
    });

    cy += R;
  }

  // Vacancy hint: turns the leftover space below a small roster into information ("room to
  // grow") instead of dead whitespace, without implying an invite feature that doesn't exist yet.
  const vacancies = FAMILY_CAP - core.members.length;
  if (vacancies > 0 && cy + 20 < y0 + viewH) {
    const vacLbl = txt(t('family.vacancies', { n: vacancies }), FS.label, MUTED);
    vacLbl.alpha = 0.75;
    vacLbl.x = x0 + 18; vacLbl.y = cy + Math.round(R * 0.2);
    list.addChild(vacLbl);
  }

  const view = { x: x0, y: y0, w: colW, h: viewH };
  const max = Math.max(0, listH - viewH);
  const bar = drawScrollIndicator(core.bodyLayer, view, core[scrollKey], max);
  core.repaint.register('members', { layer: list, key: scrollKey, view, max, bar });
}

/** Narrow slice of InputHandlers that renderChannel needs. */
export interface ChannelInput {
  openSendInput(): void;
  doSendMsg(): Promise<void>;
}

/** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderMembers` — see there. */
export function renderChannel(
  core: FamilySceneCore,
  input: ChannelInput,
  x0: number,
  colW: number,
  y0: number,
  maxH: number,
  scrollKey: 'scrollY' | 'scrollYChannel'
): void {
  const right = x0 + colW;
  const R = core.rowH;
  const inputH = Math.round(core.h * 0.05);
  const listH2 = maxH - inputH - 6;

  // Message list. The input box below stays pinned off `listH2` (the naive space reserved for
  // it); only the scrollable message area's cull/clamp/indicator use the peek-adjusted viewH2,
  // so a partial next message always peeks above the fold when there's more to scroll to.
  const msgH = core.messages.length * R;
  const viewH2 = peekViewportH(listH2, R, msgH);
  core.channelMax = Math.max(0, msgH - viewH2);
  core.channelRegionTop = y0;
  core.channelRegionBottom = y0 + viewH2;
  // Pin to the latest message (bottom) unless the user scrolled up to read history.
  if (core.channelStick) core[scrollKey] = core.channelMax;
  else core[scrollKey] = Math.max(0, Math.min(core[scrollKey], core.channelMax));

  const { layer: list } = scrollRegionLayer(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH2 });
  // One viewport of extra messages built in each direction, so a drag translates instead of
  // rebuilding — same as the roster column above (see ./repaint.ts).
  const over = viewH2;

  // Channel is returned newest-first; render oldest-at-top for natural reading (matches Sect/World chat).
  const ordered = [...core.messages].reverse();
  let cy = y0 - core[scrollKey];
  for (const msg of ordered) {
    if (cy + R < y0 - over || cy > y0 + viewH2 + over) { cy += R; continue; }
    drawChatLine(
      list, x0 + 12, cy + R / 2,
      { senderName: msg.senderName ?? msg.senderId, title: msg.title, familyName: msg.familyName },
      msg.body, FS.label, FS.label,
    );
    cy += R;
  }

  const view = { x: x0, y: y0, w: colW, h: viewH2 };
  const max = Math.max(0, msgH - viewH2);
  const bar = drawScrollIndicator(core.bodyLayer, view, core[scrollKey], max);
  core.repaint.register('channel', { layer: list, key: scrollKey, view, max, bar });

  if (core.messages.length === 0) {
    const emptyLbl = txt(t('family.noMessages'), FS.label, MUTED);
    emptyLbl.alpha = 0.8;
    emptyLbl.x = x0 + 12; emptyLbl.y = y0 + 8;
    core.bodyLayer.addChild(emptyLbl);
  }

  // Input area
  const inputY = y0 + listH2 + 4;
  const sendW = Math.round(core.h * 0.09);
  const fieldW = right - x0 - sendW - 12;
  const active = core.sendInput !== null;
  const field = sketchPanel(fieldW, inputH, { fill: 0xfaf9f5, border: active ? C.accent : C.mid, seed: seedFor(0, 0, fieldW) });
  field.x = x0 + 6; field.y = inputY;
  core.bodyLayer.addChild(field);
  // Show the typed text (+ blinking caret while focused); fall back to the placeholder when empty.
  // Routed through caretText so the 0.5 s blink and each keystroke rewrite this one Text instead of
  // the whole column (./repaint.ts). Colour is value-dependent (muted while empty), hence colorFor.
  const fl = caretText(core, {
    active,
    value: core.sendText,
    size: FS.label,
    color: (v: string) => (v.length > 0 ? C.dark : MUTED),
    placeholder: t('family.msgPlaceholder'),
  });
  fl.x = x0 + 12; fl.y = inputY + inputH / 2 - fl.height / 2;
  core.bodyLayer.addChild(fl);
  core.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: inputH }, action: () => input.openSendInput() });

  const sendBusy = core.bt.busy;
  const sendBtn = sendBusy
    ? sketchPanel(sendW, inputH, { fill: C.btnOff, border: C.mid, seed: seedFor(1, 0, sendW) })
    : sketchButton(sendW, inputH, seedFor(1, 0, sendW));
  sendBtn.x = right - sendW; sendBtn.y = inputY;
  core.bodyLayer.addChild(sendBtn);
  const sl = txt(t('family.send'), FS.heading, sendBusy ? C.mid : C.light);
  sl.anchor.set(0.5, 0.5); sl.x = right - sendW / 2; sl.y = inputY + inputH / 2;
  core.bodyLayer.addChild(sl);
  if (!sendBusy) core.hitRects.push({ rect: { x: right - sendW, y: inputY, w: sendW, h: inputH }, action: () => void input.doSendMsg() });
}
