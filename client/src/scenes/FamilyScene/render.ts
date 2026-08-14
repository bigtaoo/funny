// Per-mode rendering for the family scene: loading / noFamily / create form / myFamily (members + channel).
//
// RenderPanel depends on ActionsPanel (via ActionsHandlers — most of its surface, since nearly every
// button here fires a network action) and InputPanel (via InputHandlers — the create-form/channel
// hidden-input openers + the Send button), but neither depends back on Render: one-way, so a plain
// independent class over `core` + `actions` + `input` (2026-08-11 converted from the former
// `XMixin(Base)` inheritance chain, per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { buildIcon } from '../../render/icons';
import { buildEmblemIcon, type EmblemKey } from '../../render/emblemIcon';
import { caretDisplay } from '../../ui/inputDisplay';
import { FAMILY_CAP } from '@nw/shared';
import type { FamilySceneCore, FamilyTab } from './core';
import type { ActionsHandlers } from './actions';
import type { InputHandlers } from './input';
import { renderMembers as renderMembersImpl, renderChannel as renderChannelImpl, truncateToWidth, MUTED } from './lists';

/** Largest font size ≤ `size` (down to 11px) at which `label` fits within `maxW`. Portrait pins
 *  the width axis while h-relative sizing scales off the (much taller) height, so a fixed-box label
 *  — tab titles, bottom-bar buttons — can outrun its box; this shrinks it to fit instead of clipping.
 *  Locale-agnostic (zh / de labels differ in length). */
function fitSize(label: string, size: number, maxW: number): number {
  let s = size;
  let node = txt(label, s, 0);
  while (node.width > maxW && s > 11) {
    node.destroy();
    s -= 1;
    node = txt(label, s, 0);
  }
  node.destroy();
  return s;
}

export class RenderPanel {
  constructor(
    private readonly core: FamilySceneCore,
    private readonly actions: ActionsHandlers,
    private readonly input: InputHandlers
  ) {}

  renderLoading(): void {
    const core = this.core;
    const lbl = txt(t('world.loading'), FS.title, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = core.w / 2; lbl.y = core.h / 2;
    core.bodyLayer.addChild(lbl);
  }

  renderNoFamily(): void {
    const core = this.core;
    const { w, h } = core;
    const lbl = txt(t('family.noFamily'), FS.title, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = w / 2; lbl.y = h / 2 - h * 0.06;
    core.bodyLayer.addChild(lbl);

    const bw = Math.round(h * 0.16);
    const bh = Math.round(h * 0.055);
    const gap = Math.round(w * 0.01);

    const createBtn = sketchButton(bw, bh, seedFor(0, 0, bw));
    createBtn.x = w / 2 - bw - gap; createBtn.y = h / 2;
    core.bodyLayer.addChild(createBtn);
    const cl = txt(t('family.create'), FS.heading, C.light);
    cl.anchor.set(0.5, 0.5); cl.x = createBtn.x + bw / 2; cl.y = h / 2 + bh / 2;
    core.bodyLayer.addChild(cl);
    core.hitRects.push({ rect: { x: createBtn.x, y: h / 2, w: bw, h: bh }, action: () => { core.mode = 'create'; core.render(); } });

    const joinBtn = sketchButton(bw, bh, seedFor(1, 0, bw));
    joinBtn.x = w / 2 + gap; joinBtn.y = h / 2;
    core.bodyLayer.addChild(joinBtn);
    const jl = txt(t('family.listAll'), FS.heading, C.light);
    jl.anchor.set(0.5, 0.5); jl.x = joinBtn.x + bw / 2; jl.y = h / 2 + bh / 2;
    core.bodyLayer.addChild(jl);
    core.hitRects.push({ rect: { x: joinBtn.x, y: h / 2, w: bw, h: bh }, action: () => void this.actions.openJoinList() });
  }

  renderCreate(): void {
    const core = this.core;
    const { w, h } = core;
    const labelSize = FS.heading;
    const fieldH = Math.round(h * 0.045);
    const fieldX = Math.round(w * 0.16);
    const y1 = core.headerH + Math.round(h * 0.03);
    const y2 = y1 + Math.round(h * 0.07);
    const btnY = y2 + Math.round(h * 0.08);

    const lbl1 = txt(t('family.name') + ':', labelSize, C.dark);
    lbl1.x = 20; lbl1.y = y1 + fieldH / 2 - labelSize / 2;
    core.bodyLayer.addChild(lbl1);

    const nameField = sketchPanel(w - fieldX - 20, fieldH, { fill: 0xfaf9f5, border: core.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - fieldX) });
    nameField.x = fieldX; nameField.y = y1;
    core.bodyLayer.addChild(nameField);
    const nl = txt(caretDisplay(core.createName, core.createField === 'name' && core.caretOn, ' '), FS.heading, C.dark);
    nl.x = fieldX + 8; nl.y = y1 + fieldH / 2 - nl.height / 2;
    core.bodyLayer.addChild(nl);
    core.hitRects.push({ rect: { x: fieldX, y: y1, w: w - fieldX - 20, h: fieldH }, action: () => this.input.openInputFor('name') });

    const lbl2 = txt(t('family.tag') + ':', labelSize, C.dark);
    lbl2.x = 20; lbl2.y = y2 + fieldH / 2 - labelSize / 2;
    core.bodyLayer.addChild(lbl2);

    const tagW = Math.round(w * 0.14);
    const tagField = sketchPanel(tagW, fieldH, { fill: 0xfaf9f5, border: core.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, tagW) });
    tagField.x = fieldX; tagField.y = y2;
    core.bodyLayer.addChild(tagField);
    const tl = txt(caretDisplay(core.createTag, core.createField === 'tag' && core.caretOn, ' '), FS.heading, C.dark);
    tl.x = fieldX + 8; tl.y = y2 + fieldH / 2 - tl.height / 2;
    core.bodyLayer.addChild(tl);
    core.hitRects.push({ rect: { x: fieldX, y: y2, w: tagW, h: fieldH }, action: () => this.input.openInputFor('tag') });

    const hint = txt('[A-Z0-9] 2-5 chars', FS.label, MUTED);
    hint.x = fieldX + tagW + 12; hint.y = y2 + fieldH / 2 - hint.height / 2;
    core.bodyLayer.addChild(hint);

    const okW = Math.round(w * 0.13);
    const btnH = Math.round(h * 0.05);
    const createBusy = core.bt.busy;
    const okBtn = createBusy
      ? sketchPanel(okW, btnH, { fill: C.btnOff, border: C.mid, seed: seedFor(0, 0, okW) })
      : sketchButton(okW, btnH, seedFor(0, 0, okW));
    okBtn.x = w / 2 - okW - 10; okBtn.y = btnY;
    core.bodyLayer.addChild(okBtn);
    const ok = txt(t('family.create'), FS.heading, createBusy ? C.mid : C.light);
    ok.anchor.set(0.5, 0.5); ok.x = okBtn.x + okW / 2; ok.y = btnY + btnH / 2;
    core.bodyLayer.addChild(ok);
    if (!createBusy) core.hitRects.push({ rect: { x: okBtn.x, y: btnY, w: okW, h: btnH }, action: () => void this.actions.doCreate() });

    const cancelBtn = sketchPanel(okW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, okW) });
    cancelBtn.x = w / 2 + 10; cancelBtn.y = btnY;
    core.bodyLayer.addChild(cancelBtn);
    const caSize = Math.round(btnH * 0.5);
    const ca = buildIcon('close', caSize, C.dark);
    ca.x = cancelBtn.x + okW / 2 - caSize / 2; ca.y = btnY + btnH / 2 - caSize / 2;
    core.bodyLayer.addChild(ca);
    core.hitRects.push({ rect: { x: cancelBtn.x, y: btnY, w: okW, h: btnH }, action: () => { core.mode = 'noFamily'; core.render(); } });
  }

  renderMyFamily(): void {
    const core = this.core;
    if (!core.family) return;

    // Landscape has room for both columns permanently side by side (matches how mobile SLG
    // alliance UIs handle this — roster + chat both visible — instead of a tab that leaves
    // whichever side is picked mostly blank when the roster/history is short). Portrait keeps
    // the tab switch since there's no width to spare for two columns.
    if (core.landscape) {
      this.renderSplitView();
    } else {
      this.renderTabbedView();
    }
  }

  private renderTabbedView(): void {
    const core = this.core;
    const { w, h } = core;

    // Rail itself is now drawn unconditionally by the outer render() dispatcher (see ../FamilyScene.ts).

    // Tab bar — starts to the right of the social hub rail so it doesn't sit on top of it,
    // matching the EquipmentScene/GachaScene convention.
    const left = core.railW;
    const tabH = Math.round(h * 0.05);
    const tabs: FamilyTab[] = ['members', 'channel'];
    const tabW = (w - left) / tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]!;
      const active = tab === core.activeTab;
      const tx = left + i * tabW;
      const tp = sketchPanel(tabW, tabH, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
      tp.x = tx; tp.y = core.headerH;
      core.bodyLayer.addChild(tp);
      const tabLabel = t(tab === 'members' ? 'family.tabMembers' : 'family.channel');
      const tl = txt(tabLabel, fitSize(tabLabel, FS.heading, tabW - 16), active ? C.accent : C.dark);
      tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = core.headerH + tabH / 2;
      core.bodyLayer.addChild(tl);
      core.hitRects.push({ rect: { x: tx, y: core.headerH, w: tabW, h: tabH }, action: () => { core.activeTab = tab; core.scrollY = 0; core.channelStick = true; core.render(); } });
    }

    const infoY = core.headerH + tabH;
    this.renderInfoBand(infoY);

    const contentY = infoY + core.infoBandH;
    const contentH = core.bodyBottom - contentY - 6;

    if (core.activeTab === 'members') {
      const btnH = this.renderPendingButton(left, w - left, contentY);
      this.renderMembers(left, w - left, contentY + btnH, contentH - btnH, 'scrollY');
    } else {
      this.renderChannel(left, w - left, contentY, contentH, 'scrollYChannel');
    }
  }

  /** Landscape: roster (left) + family channel (right) always visible side by side. */
  private renderSplitView(): void {
    const core = this.core;
    const { w, h } = core;
    const left = core.railW;

    const infoY = core.headerH + 8;
    this.renderInfoBand(infoY);

    const colLblSize = FS.label;
    const colLblGap = Math.round(colLblSize * 1.4);
    const contentY = infoY + core.infoBandH + colLblGap;
    const contentH = h - contentY - 6;

    const totalW = w - left;
    const rosterW = Math.round(totalW * 0.42);
    const chatX = left + rosterW + 12;
    const chatW = w - chatX - 8;
    core.chatColX = chatX - 6;

    // Unified header band behind both column titles (Members / Family Channel) so they read as
    // one section strip rather than two labels floating on the ruled paper.
    const bandY = contentY - colLblGap - 4;
    const bandH = colLblGap + 4;
    const band = new PIXI.Graphics();
    band.beginFill(C.dark, 0.06);
    band.drawRect(left, bandY, w - 8 - left, bandH);
    band.endFill();
    band.lineStyle(1, C.mid, 0.5);
    band.moveTo(left, bandY + bandH).lineTo(w - 8, bandY + bandH);
    core.bodyLayer.addChild(band);

    const membersLbl = txt(t('family.tabMembers'), colLblSize, MUTED);
    membersLbl.x = left + 12; membersLbl.y = contentY - colLblGap;
    core.bodyLayer.addChild(membersLbl);
    const channelLbl = txt(t('family.channel'), colLblSize, MUTED);
    channelLbl.x = chatX + 4; channelLbl.y = contentY - colLblGap;
    core.bodyLayer.addChild(channelLbl);

    const divider = new PIXI.Graphics();
    divider.lineStyle(1, C.mid, 0.5);
    divider.moveTo(core.chatColX, contentY - colLblGap - 4).lineTo(core.chatColX, contentY + contentH);
    core.bodyLayer.addChild(divider);

    const btnH = this.renderPendingButton(left, rosterW, contentY);
    this.renderMembers(left, rosterW, contentY + btnH, contentH - btnH, 'scrollY');
    this.renderChannel(chatX, chatW, contentY, contentH, 'scrollYChannel');
  }

  /** Leader/elder-only "N pending applicants" button shown above the roster when there's at least
   *  one open join request; opens the approve/reject modal (actions.ts openJoinRequests). Returns
   *  the vertical space it consumed (0 when hidden) so callers can shrink the roster area by it. */
  private renderPendingButton(x0: number, colW: number, y: number): number {
    const core = this.core;
    if (!core.isFamilyApprover || core.joinRequests.length === 0) return 0;
    const btnH = Math.round(core.rowH * 0.8);
    const btn = sketchPanel(colW - 12, btnH - 4, { fill: 0xfff3d6, border: 0xd4a030, seed: seedFor(y, 9, colW) });
    btn.x = x0 + 6; btn.y = y + 2;
    core.bodyLayer.addChild(btn);
    const lbl = txt(t('family.pendingRequests', { n: core.joinRequests.length }), FS.bodyLg, 0xa9750f, true);
    lbl.anchor.set(0, 0.5); lbl.x = x0 + 18; lbl.y = y + btnH / 2;
    core.bodyLayer.addChild(lbl);
    const arrow = txt('›', FS.bodyLg, 0xa9750f);
    arrow.anchor.set(1, 0.5); arrow.x = x0 + colW - 20; arrow.y = y + btnH / 2;
    core.bodyLayer.addChild(arrow);
    core.hitRects.push({ rect: { x: x0 + 6, y: y + 2, w: colW - 12, h: btnH - 4 }, action: () => this.actions.openJoinRequests() });
    return btnH;
  }

  /** Family identity band: `[TAG] Name` + member count on row 1, prosperity on row 2, optional
   *  announcement on row 3. Split across rows (rather than one packed line) so a long name or
   *  narrow portrait width can never make more than two labels fight for the same space. */
  private renderInfoBand(y0: number): void {
    const core = this.core;
    if (!core.family) return;
    const { w } = core;
    const left = core.railW;
    const fam = core.family;

    // Landscape: the identity (name/prosperity/count) now lives in the header — here we only
    // surface the announcement, if any, on a slim band below the bar.
    if (core.landscape) {
      if (fam.announcement) {
        const annLbl = truncateToWidth(fam.announcement, FS.label, MUTED, w - (left + 12) - 12);
        annLbl.x = left + 12; annLbl.y = y0 + 4;
        core.bodyLayer.addChild(annLbl);
      }
      return;
    }

    const B = core.infoBandH;

    const countLbl = txt(t('family.memberCount', { n: fam.memberCount, cap: FAMILY_CAP }), FS.label, MUTED);
    countLbl.anchor.set(1, 0); countLbl.x = w - 12; countLbl.y = y0 + Math.round(B * 0.08);
    core.bodyLayer.addChild(countLbl);

    // Emblem badge (family-emblem-art-prompts.md, 2026-08-14) — same tap-to-open-picker affordance
    // as the landscape header (drawHeaderTitle), just laid out inline in this row instead.
    let nameX = left + 12;
    const emblemSize = Math.round(B * 0.42);
    const key = fam.emblemKey as EmblemKey | undefined;
    const emblemNode = key ? buildEmblemIcon(key, emblemSize, fam.emblemColor ?? C.dark) : null;
    if (emblemNode || core.isFamilyLeader) {
      const badge = emblemNode ?? (() => {
        const ph = new PIXI.Graphics();
        ph.lineStyle(1.4, C.mid, 0.9);
        ph.drawCircle(emblemSize / 2, emblemSize / 2, emblemSize / 2 - 1);
        ph.moveTo(emblemSize * 0.3, emblemSize / 2).lineTo(emblemSize * 0.7, emblemSize / 2);
        ph.moveTo(emblemSize / 2, emblemSize * 0.3).lineTo(emblemSize / 2, emblemSize * 0.7);
        return ph;
      })();
      badge.x = nameX; badge.y = y0 + Math.round(B * 0.06);
      core.bodyLayer.addChild(badge);
      if (core.isFamilyLeader) {
        core.hitRects.push({ rect: { x: badge.x, y: badge.y, w: emblemSize, h: emblemSize }, action: () => core.openEmblemPicker() });
      }
      nameX += emblemSize + 8;
    }

    const maxNameW = Math.max(40, w - 12 - nameX - countLbl.width - 16);
    const nameLbl = truncateToWidth(`[${fam.tag}] ${fam.name}`, FS.title, C.dark, maxNameW);
    nameLbl.x = nameX; nameLbl.y = y0 + Math.round(B * 0.05);
    core.bodyLayer.addChild(nameLbl);

    const starSize = core.fs(0.024);
    const prosY = y0 + Math.round(B * 0.46);
    const star = buildIcon('star', starSize, 0xd4a030);
    star.x = left + 12; star.y = prosY;
    core.bodyLayer.addChild(star);
    const prosLbl = txt(t('family.prosperity', { n: fam.prosperity }), FS.label, 0xa9750f);
    prosLbl.x = left + 12 + starSize + 6; prosLbl.y = prosY - 2;
    core.bodyLayer.addChild(prosLbl);

    if (fam.announcement) {
      const annLbl = truncateToWidth(fam.announcement, FS.label, MUTED, w - (left + 12) - 12);
      annLbl.x = left + 12; annLbl.y = y0 + Math.round(B * 0.78);
      core.bodyLayer.addChild(annLbl);
    }
  }

  /** Roster column. `x0`/`colW` let this render either full-width (portrait tab) or as the
   *  left half of the landscape split view; `scrollKey` picks which scroll field this
   *  instance owns so the two columns can scroll independently in the split view. Delegates to
   *  lists.ts (2026-08-11, form ① — see claudedocs/client-modules.md's split-form priority note). */
  private renderMembers(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
    renderMembersImpl(this.core, this.actions, x0, colW, y0, maxH, scrollKey);
  }

  /** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderMembers` — see there.
   *  Delegates to lists.ts (2026-08-11, form ① — see claudedocs/client-modules.md's split-form
   *  priority note). */
  private renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
    renderChannelImpl(this.core, this.input, x0, colW, y0, maxH, scrollKey);
  }
}
