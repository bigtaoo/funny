// Family-roster + channel-message column rendering — split out of render.ts (2026-08-11, form ①
// independent function module per claudedocs/client-modules.md's split-form priority note) purely
// to keep render.ts under the 500-line convention. Only ever called from RenderPanel's own
// renderFamiliesList/renderChannel delegate methods, so these take `core` explicitly instead of
// becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../../ui/widgets/scrollPeek';
import { caretDisplay } from '../../ui/inputDisplay';
import { drawChatLine } from '../../ui/widgets/chatRow';
import { FS } from '../../render/fontScale';
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

  const list = new PIXI.Container();
  const mask = new PIXI.Graphics().beginFill(0xffffff).drawRect(x0, y0, colW, viewH).endFill();
  list.mask = mask;
  core.bodyLayer.addChild(list, mask);

  let cy = y0 - core[scrollKey];
  for (const fam of sect.memberFamilies) {
    if (cy + ROW_H >= y0 && cy <= y0 + viewH) {
      const isLeaderFam = fam.familyId === sect.leaderFamilyId;
      const bar = new PIXI.Graphics();
      sketchAccentBar(bar, ROW_H - 6, isLeaderFam ? C.accent : C.mid);
      bar.x = x0 + 6; bar.y = cy + 3;
      list.addChild(bar);

      // Row 1: family name, with the "Leader family" tag inline to its right.
      const nameLbl = txt(`[${fam.tag}] ${fam.name}`, FS.heading, C.dark);
      nameLbl.x = x0 + 18; nameLbl.y = cy + 8;
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
        if (!busy) core.hitRects.push({ rect: { x: voteBtnX, y: cy + (ROW_H - 34) / 2, w: voteW, h: 34 }, action: () => actions.confirmVote(nomId, nomLabel) });
      }
    }
    cy += ROW_H;
  }

  drawScrollIndicator(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH }, core[scrollKey], Math.max(0, listH - viewH));
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
  const right = x0 + colW;
  const inputH = 52;
  const availH2 = maxH - inputH - 6;

  if (core.messages.length === 0) {
    const empty = txt(t('sect.noMessages'), FS.label, C.mid);
    empty.anchor.set(0.5, 0); empty.x = x0 + colW / 2; empty.y = y0 + 8;
    core.bodyLayer.addChild(empty);
  }

  const msgH = core.messages.length * ROW_H;
  // Clamp the viewport so it always cuts mid-row when there's more below — a partial next
  // message always peeks above the fold instead of landing flush with the input box.
  const viewH2 = peekViewportH(availH2, ROW_H, msgH);
  core.channelMax = Math.max(0, msgH - viewH2);
  core.channelRegionTop = y0;
  core.channelRegionBottom = y0 + viewH2;
  // Pin to the latest message (bottom) unless the user scrolled up to read history.
  if (core.channelStick) core[scrollKey] = core.channelMax;
  else core[scrollKey] = Math.max(0, Math.min(core[scrollKey], core.channelMax));

  const list = new PIXI.Container();
  const mask = new PIXI.Graphics().beginFill(0xffffff).drawRect(x0, y0, colW, viewH2).endFill();
  list.mask = mask;
  core.bodyLayer.addChild(list, mask);

  // Channel is returned newest-first; render oldest-at-top for natural reading.
  const ordered = [...core.messages].reverse();
  let cy = y0 - core[scrollKey];
  for (const msg of ordered) {
    if (cy + ROW_H < y0 || cy > y0 + viewH2) { cy += ROW_H; continue; }
    drawChatLine(
      list, x0 + 12, cy + ROW_H / 2,
      { senderName: msg.senderName, title: msg.title, sectName: msg.sectName, familyName: msg.familyName },
      msg.body, FS.label, FS.label,
    );
    cy += ROW_H;
  }

  drawScrollIndicator(core.bodyLayer, { x: x0, y: y0, w: colW, h: viewH2 }, core[scrollKey], Math.max(0, msgH - viewH2));

  const inputY = y0 + availH2 + 4;
  const sendW = 96;
  const fieldW = colW - sendW - 12;
  const field = sketchPanel(fieldW, inputH, { fill: 0xfaf9f5, border: core.channelActive ? C.accent : C.mid, seed: seedFor(0, 0, fieldW) });
  field.x = x0 + 6; field.y = inputY;
  core.bodyLayer.addChild(field);
  const fl = txt(
    caretDisplay(core.channelInput, core.channelActive && core.caretOn, t('sect.msgPlaceholder')),
    FS.label, core.channelInput ? C.dark : C.mid,
  );
  fl.anchor.set(0, 0.5); fl.x = x0 + 12; fl.y = inputY + inputH / 2;
  core.bodyLayer.addChild(fl);
  core.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: inputH }, action: () => input.openSendInput() });

  const sendLabel = core.channelSending ? t('sect.sending') : t('sect.send');
  const sendBtn = sketchButton(sendW, inputH, seedFor(1, 0, sendW));
  sendBtn.x = right - sendW; sendBtn.y = inputY;
  core.bodyLayer.addChild(sendBtn);
  const sl = txt(sendLabel, FS.heading, C.light);
  sl.anchor.set(0.5, 0.5); sl.x = right - sendW / 2; sl.y = inputY + inputH / 2;
  core.bodyLayer.addChild(sl);
  core.hitRects.push({
    rect: { x: right - sendW, y: inputY, w: sendW, h: inputH },
    action: () => { if (!core.channelSending) void actions.doSendChannelMessage(); },
  });
}
