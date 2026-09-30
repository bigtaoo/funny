// Family-roster + channel-message column rendering — split out of render.ts (2026-08-11, form ①
// independent function module per claudedocs/client-modules.md's split-form priority note) purely
// to keep render.ts under the 500-line convention. Only ever called from RenderPanel's own
// renderFamiliesList/renderChannel delegate methods, so these take `core` explicitly instead of
// becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { isChatDisabled } from '../../ui/chatPolicy';
import { ui as C, txt, sketchPanel, sketchButton, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { scrollRegionLayer } from '../../ui/widgets/scrollRegionLayer';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { caretText } from './repaint';
import { drawChatLine } from '../../ui/widgets/chatRow';
import { isBlocked, messageContent, openPlayerCard } from '../../ui/moderation';
import type { SectMessageView } from '../../net/WorldApiClient';

/**
 * The sender's publicId for a sect-channel message. SectMessageView carries only the accountId
 * today, so this is empty until the server adds `senderPublicId` (worldsvc SectMessageView, App
 * Review 1.2) — rows without it simply have no Report/Block card and are never
 * filtered, since a block is keyed on publicId.
 */
function senderPublicIdOf(msg: SectMessageView): string | undefined {
  return msg.senderPublicId || undefined;
}

/** Left inset of a channel row, mirrored on the right as the row's truncation margin. This is the
 *  narrow half of a split view, so it is what actually bounds a message — see chatRow.ts. */
const ROW_INSET = 12;
import { buildEmblemIcon, type EmblemKey } from '../../render/emblemIcon';
import { FS } from '../../render/fontScale';
import { drawButtonLabel } from '../../ui/widgets/buttonLabel';
import type { SectSceneCore } from './core';
import { ROW_H } from './core';

/** Narrow slice of ActionsHandlers that renderFamiliesList needs. */
export interface VoteAction {
  confirmVote(nomineeFamilyId: string, nomineeLabel: string): void;
}

/** Family-list column. `x0`/`colW`/`scrollKey` let this render either full-width (portrait tab)
 *  or as the left half of the landscape split view; `scrollKey` picks which scroll field this
 *  instance owns so the two columns can scroll independently in the split view. */
export function renderFamiliesList(
  core: SectSceneCore,
  actions: VoteAction,
  x0: number,
  colW: number,
  y0: number,
  maxH: number,
  scrollKey: 'scrollY' | 'scrollYChannel'
): void {
  if (!core.sect) return;
  const sect = core.sect;
  const right = x0 + colW;

  const listH = sect.memberFamilies.length * ROW_H;
  // Clamp the viewport so it always cuts mid-row when there's more below — a partial next
  // family row always peeks above the fold instead of landing flush with the column edge.
  const viewH = peekViewportH(maxH, ROW_H, listH);
  core.familiesMax = Math.max(0, listH - viewH);
  core.familiesRegionTop = y0;
  core.familiesRegionBottom = y0 + viewH;
  core[scrollKey] = Math.max(0, Math.min(core[scrollKey], core.familiesMax));

  // Rows are built one viewport beyond the mask in each direction (`over`), so a drag inside that
  // band just translates `list` instead of rebuilding every hand-drawn row — see ./repaint.ts.
  const { layer: list } = scrollRegionLayer(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH });
  const over = viewH;

  let cy = y0 - core[scrollKey];
  for (const fam of sect.memberFamilies) {
    if (cy + ROW_H >= y0 - over && cy <= y0 + viewH + over) {
      const isLeaderFam = fam.familyId === sect.leaderFamilyId;
      const bar = new PIXI.Graphics();
      sketchAccentBar(bar, ROW_H - 6, isLeaderFam ? C.accent : C.mid);
      bar.x = x0 + 6; bar.y = cy + 3;
      list.addChild(bar);

      // Row 1: emblem badge (if the family picked one) + family name, with the "Leader family" tag
      // inline to its right (family-emblem-art-prompts.md, 2026-08-14).
      let nameX = x0 + 18;
      const emblemKey = fam.emblemKey as EmblemKey | undefined;
      if (emblemKey) {
        const emblemSize = Math.round(FS.heading * 1.1);
        const badge = buildEmblemIcon(emblemKey, emblemSize, fam.emblemColor ?? C.dark);
        if (badge) {
          badge.x = nameX; badge.y = cy + 8;
          list.addChild(badge);
          nameX += emblemSize + 6;
        }
      }
      const nameLbl = txt(`[${fam.tag}] ${fam.name}`, FS.heading, C.dark);
      nameLbl.x = nameX; nameLbl.y = cy + 8;
      list.addChild(nameLbl);
      if (isLeaderFam) {
        const ldr = txt(t('sect.leaderFamily'), FS.small, C.accent);
        ldr.anchor.set(0, 0.5); ldr.x = nameLbl.x + nameLbl.width + 12; ldr.y = cy + 8 + nameLbl.height / 2;
        list.addChild(ldr);
      }
      // Row 2: member / territory counts.
      const statLbl = txt(`${t('family.members', { n: fam.memberCount })} · ${t('sect.territory', { n: fam.territoryCount })}`, FS.body, C.mid);
      statLbl.x = x0 + 18; statLbl.y = cy + 8 + nameLbl.height + 6;
      list.addChild(statLbl);

      // Any family leader (except the current leader family) can launch / vote a removal.
      if (core.isFamilyLeader && !isLeaderFam) {
        const busy = core.bt.busy;
        const voteColor = busy ? C.mid : C.red;
        const voteW = 104, voteBtnX = right - voteW - 12;
        const voteBtn = sketchPanel(voteW, 34, { fill: 0xf0e0e0, border: voteColor, seed: seedFor(cy, 1, voteW) });
        voteBtn.x = voteBtnX; voteBtn.y = cy + (ROW_H - 34) / 2;
        list.addChild(voteBtn);
        const vl = txt(t('sect.vote'), FS.body, voteColor);
        vl.anchor.set(0.5, 0.5); vl.x = voteBtnX + voteW / 2; vl.y = cy + ROW_H / 2;
        list.addChild(vl);
        const nomId = fam.familyId;
        const nomLabel = `[${fam.tag}] ${fam.name}`;
        if (!busy) core.hitRects.push({ rect: { x: voteBtnX, y: cy + (ROW_H - 34) / 2, w: voteW, h: 34 }, fn: () => actions.confirmVote(nomId, nomLabel), scroll: 'families' });
      }
    }
    cy += ROW_H;
  }

  const view = { x: x0, y: y0, w: colW, h: viewH };
  const max = Math.max(0, listH - viewH);
  const bar = drawScrollIndicator(core.bodyLayer, view, core[scrollKey], max);
  core.repaint.register('families', { layer: list, key: scrollKey, view, max, bar });
}

/** Narrow slice of ActionsHandlers + InputHandlers that renderChannel needs. */
export interface ChannelActions {
  doSendChannelMessage(): Promise<void>;
}
export interface ChannelInput {
  openSendInput(): void;
}

/** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderFamiliesList` — see
 *  there. Renders full-width in the portrait tab, or the right half of the landscape split view. */
export function renderChannel(
  core: SectSceneCore,
  actions: ChannelActions,
  input: ChannelInput,
  x0: number,
  colW: number,
  y0: number,
  maxH: number,
  scrollKey: 'scrollY' | 'scrollYChannel'
): void {
  if (isChatDisabled()) {
    const off = txt(t('chat.disabled'), FS.label, C.mid);
    off.anchor.set(0.5, 0); off.x = x0 + colW / 2; off.y = y0 + 8;
    core.bodyLayer.addChild(off);
    return;
  }
  const right = x0 + colW;
  const inputH = 52;
  const availH2 = maxH - inputH - 6;

  // A blocked player's messages are dropped at render time (App Review 1.2), so a block — or a live
  // push from them — never shows. Channel is returned newest-first; render oldest-at-top.
  const ordered = core.messages.filter((m) => !isBlocked(senderPublicIdOf(m))).reverse();
  if (ordered.length === 0) {
    const empty = txt(t('sect.noMessages'), FS.label, C.mid);
    empty.anchor.set(0.5, 0); empty.x = x0 + colW / 2; empty.y = y0 + 8;
    core.bodyLayer.addChild(empty);
  }

  const msgH = ordered.length * ROW_H;
  // Clamp the viewport so it always cuts mid-row when there's more below — a partial next
  // message always peeks above the fold instead of landing flush with the input box.
  const viewH2 = peekViewportH(availH2, ROW_H, msgH);
  core.channelMax = Math.max(0, msgH - viewH2);
  core.channelRegionTop = y0;
  core.channelRegionBottom = y0 + viewH2;
  // Pin to the latest message (bottom) unless the user scrolled up to read history.
  if (core.channelStick) core[scrollKey] = core.channelMax;
  else core[scrollKey] = Math.max(0, Math.min(core[scrollKey], core.channelMax));

  // One viewport of extra messages built in each direction, so a drag translates instead of
  // rebuilding — same as the families column above (see ./repaint.ts).
  const { layer: list } = scrollRegionLayer(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH2 });
  const over = viewH2;

  let cy = y0 - core[scrollKey];
  for (const msg of ordered) {
    if (cy + ROW_H < y0 - over || cy > y0 + viewH2 + over) { cy += ROW_H; continue; }
    drawChatLine(
      list, x0 + ROW_INSET, cy + ROW_H / 2,
      { senderName: msg.senderName, title: msg.title, sectName: msg.sectName, familyName: msg.familyName },
      msg.body, FS.label, FS.label, colW - ROW_INSET * 2,
    );
    // Someone else's message: tap for their card — Report (this message) / Block.
    const publicId = senderPublicIdOf(msg);
    if (publicId && msg.senderId !== core.cb.myAccountId) {
      const target = { publicId, name: msg.senderName, content: messageContent('sect', msg.body, msg.id) };
      core.hitRects.push({ rect: { x: x0, y: cy, w: colW, h: ROW_H }, fn: () => openPlayerCard(target), scroll: 'channel' });
    }
    cy += ROW_H;
  }

  const view = { x: x0, y: y0, w: colW, h: viewH2 };
  const max = Math.max(0, msgH - viewH2);
  const bar = drawScrollIndicator(core.bodyLayer, view, core[scrollKey], max);
  core.repaint.register('channel', { layer: list, key: scrollKey, view, max, bar });

  const inputY = y0 + availH2 + 4;
  const sendW = 96;
  const fieldW = colW - sendW - 12;
  const field = sketchPanel(fieldW, inputH, { fill: 0xfaf9f5, border: core.channelActive ? C.accent : C.mid, seed: seedFor(0, 0, fieldW) });
  field.x = x0 + 6; field.y = inputY;
  core.bodyLayer.addChild(field);
  // Routed through caretText so the 0.5 s blink and each keystroke rewrite this one Text instead of
  // the whole column (./repaint.ts). Colour is value-dependent (grey while empty), hence colorFor.
  const fl = caretText(core, {
    active: core.channelActive,
    value: core.channelInput,
    size: FS.label,
    color: (v: string) => (v ? C.dark : C.mid),
    placeholder: t('sect.msgPlaceholder'),
  });
  fl.anchor.set(0, 0.5); fl.x = x0 + 12; fl.y = inputY + inputH / 2;
  core.bodyLayer.addChild(fl);
  core.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: inputH }, fn: () => input.openSendInput() });

  const sendLabel = core.channelSending ? t('sect.sending') : t('sect.send');
  const sendBtn = sketchButton(sendW, inputH, seedFor(1, 0, sendW));
  sendBtn.x = right - sendW; sendBtn.y = inputY;
  core.bodyLayer.addChild(sendBtn);
  drawButtonLabel(core.bodyLayer, right - sendW, inputY, sendW, inputH, sendLabel, 'channelTabIcon',
    C.light, FS.heading);
  core.hitRects.push({
    rect: { x: right - sendW, y: inputY, w: sendW, h: inputH },
    fn: () => { if (!core.channelSending) void actions.doSendChannelMessage(); },
  });
}
