// Render domain: the mode-specific views (loading / no-sect / create form / my-sect with the
// families + channel tabs) plus the small center-message / center-button / bottom-bar-button helpers.
//
// RenderPanel depends on ActionsPanel (via ActionsHandlers — most of its surface, since nearly every
// button here fires a network action) and InputPanel (via InputHandlers — the create-form/channel
// hidden-input openers), but neither depends back on Render: one-way, so a plain independent class
// over `core` + `actions` + `input` (2026-08-11 converted from the former `XMixin(Base)` inheritance
// chain, per claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import { SECT_CREATE_COST } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, seedFor } from '../../render/sketchUi';
import { buildEmblemIcon, type EmblemKey } from '../../render/emblemIcon';
import { caretDisplay } from '../../ui/inputDisplay';
import { FS } from '../../render/fontScale';
import type { SectSceneCore, SectTab } from './core';
import type { ActionsHandlers } from './actions';
import type { InputHandlers } from './input';
import { renderFamiliesList as renderFamiliesListImpl, renderChannel as renderChannelImpl } from './lists';

export class RenderPanel {
  constructor(
    private readonly core: SectSceneCore,
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

  renderNoSect(): void {
    const core = this.core;
    const { w, h } = core;

    // Players who aren't a family leader can't act on the sect.
    if (!core.inFamily) {
      this.centerMessage(t('sect.notInFamily'));
      return;
    }
    if (!core.isFamilyLeader) {
      this.centerMessage(t('sect.notLeader'));
      return;
    }

    const lbl = txt(t('sect.noSect'), FS.heading, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = w / 2; lbl.y = h / 2 - 100;
    core.bodyLayer.addChild(lbl);

    const hint = txt(t('sect.createHint', { n: SECT_CREATE_COST }), FS.label, C.mid);
    hint.anchor.set(0.5, 0.5);
    hint.x = w / 2; hint.y = h / 2 - 56;
    core.bodyLayer.addChild(hint);

    const canAffordCreate = core.cb.getCoins() >= SECT_CREATE_COST;
    this.addCenterButton(
      t('sect.create'), w / 2 - 260, h / 2,
      () => { core.mode = 'create'; core.render(); },
      0, canAffordCreate,
    );
    this.addCenterButton(t('sect.browse'), w / 2 + 20, h / 2, () => void this.actions.openBrowseList(), 1);
  }

  renderCreate(): void {
    const core = this.core;
    const { w, h } = core;

    // Whole create-form is scaled up uniformly (constants + fonts) by S so it reads larger
    // without touching the global font scale. Every geometry value below is pre-multiplied.
    const S = 1.3;

    // Everything lives inside a centered card in the region RIGHT of the social rail — the
    // old absolute-x layout overlapped the rail (Family/Sect/World/Mail) and the header text.
    const left = core.railW;
    const availW = w - left;
    const cardW = Math.min(720 * S, availW * 0.9);
    const cardX = left + (availW - cardW) / 2;
    const pad = 36 * S;
    const cx = cardX + cardW / 2;      // card horizontal center (used for title + buttons)
    const inX = cardX + pad;            // inner content left edge
    const inW = cardW - pad * 2;        // inner content width
    const fieldH = 48 * S;

    // Field metrics chosen up front so we can size the card to its content.
    const titleH = 34 * S, gapAfterTitle = 26 * S;
    const labelH = 26 * S, gapLabelField = 8 * S;
    const gapAfterName = 30 * S;
    const tagLabelH = 24 * S, tagHintH = 20 * S;
    const tagFieldW = Math.min(260 * S, inW);
    const gapAfterTag = 40 * S;
    const btnH = 48 * S;

    const cardH = pad
      + titleH + gapAfterTitle
      + labelH + gapLabelField + fieldH + gapAfterName
      + tagLabelH + tagHintH + fieldH + gapAfterTag
      + btnH
      + pad;
    const cardY = Math.max(core.headerH + 20, core.headerH + (h - core.headerH - cardH) / 2);

    // Card background.
    const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(7, 0, cardW) });
    card.x = cardX; card.y = cardY;
    core.bodyLayer.addChild(card);

    let y = cardY + pad;

    // Title.
    const title = txt(t('sect.createTitle'), FS.label * S, C.dark);
    title.anchor.set(0.5, 0); title.x = cx; title.y = y;
    core.bodyLayer.addChild(title);
    y += titleH + gapAfterTitle;

    // ── Sect name ──
    const nameLbl = txt(t('sect.name'), FS.body * S, C.dark);
    nameLbl.x = inX; nameLbl.y = y;
    core.bodyLayer.addChild(nameLbl);
    y += labelH + gapLabelField;

    const nameFocused = core.createField === 'name';
    const nameField = sketchPanel(inW, fieldH, { fill: 0xfaf9f5, border: nameFocused ? C.accent : C.mid, seed: seedFor(0, 0, inW) });
    nameField.x = inX; nameField.y = y;
    core.bodyLayer.addChild(nameField);
    const nameEmpty = core.createName.length === 0 && !nameFocused;
    const nl = txt(nameEmpty ? t('social.sect.namePlaceholder') : caretDisplay(core.createName, nameFocused && core.caretOn, ' '), FS.bodyLg * S, nameEmpty ? C.mid : C.dark);
    nl.anchor.set(0, 0.5); nl.x = inX + 12 * S; nl.y = y + fieldH / 2;
    core.bodyLayer.addChild(nl);
    core.hitRects.push({ rect: { x: inX, y, w: inW, h: fieldH }, action: () => this.input.openInputFor('name') });
    y += fieldH + gapAfterName;

    // ── Tag (short label + hint line underneath) ──
    const tagLbl = txt(t('sect.tagLabel'), FS.body * S, C.dark);
    tagLbl.x = inX; tagLbl.y = y;
    core.bodyLayer.addChild(tagLbl);
    y += tagLabelH;
    const tagHint = txt(t('sect.tagHint'), FS.tiny * S, C.mid);
    tagHint.x = inX; tagHint.y = y;
    core.bodyLayer.addChild(tagHint);
    y += tagHintH;

    const tagFocused = core.createField === 'tag';
    const tagField = sketchPanel(tagFieldW, fieldH, { fill: 0xfaf9f5, border: tagFocused ? C.accent : C.mid, seed: seedFor(1, 0, tagFieldW) });
    tagField.x = inX; tagField.y = y;
    core.bodyLayer.addChild(tagField);
    const tl = txt(caretDisplay(core.createTag, tagFocused && core.caretOn, ' '), FS.bodyLg * S, C.dark);
    tl.anchor.set(0, 0.5); tl.x = inX + 12 * S; tl.y = y + fieldH / 2;
    core.bodyLayer.addChild(tl);
    core.hitRects.push({ rect: { x: inX, y, w: tagFieldW, h: fieldH }, action: () => this.input.openInputFor('tag') });
    y += fieldH + gapAfterTag;

    // ── Buttons (create + cancel, side by side, centered under the fields) ──
    const btnW = 150 * S, btnGap = 24 * S;
    const okX = cx - btnW - btnGap / 2;
    const cancelX = cx + btnGap / 2;

    const createBusy = core.bt.busy;
    const okBtn = createBusy
      ? sketchPanel(btnW, btnH, { fill: C.btnOff, border: C.mid, seed: seedFor(0, 1, btnW) })
      : sketchButton(btnW, btnH, seedFor(0, 1, btnW));
    okBtn.x = okX; okBtn.y = y;
    core.bodyLayer.addChild(okBtn);
    const ok = txt(t('sect.create'), FS.body * S, createBusy ? C.mid : C.light);
    ok.anchor.set(0.5, 0.5); ok.x = okX + btnW / 2; ok.y = y + btnH / 2;
    core.bodyLayer.addChild(ok);
    if (!createBusy) core.hitRects.push({ rect: { x: okX, y, w: btnW, h: btnH }, action: () => void this.actions.doCreate() });

    const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 1, btnW) });
    cancelBtn.x = cancelX; cancelBtn.y = y;
    core.bodyLayer.addChild(cancelBtn);
    const ca = txt(t('social.sect.cancel'), FS.body * S, C.dark);
    ca.anchor.set(0.5, 0.5); ca.x = cancelX + btnW / 2; ca.y = y + btnH / 2;
    core.bodyLayer.addChild(ca);
    core.hitRects.push({ rect: { x: cancelX, y, w: btnW, h: btnH }, action: () => { core.mode = 'noSect'; core.render(); } });
  }

  renderMySect(): void {
    const core = this.core;
    if (!core.sect) return;
    // Landscape has room for both columns permanently side by side (matches FamilyScene) — a tab
    // switch left whichever side wasn't selected mostly blank. Portrait keeps the tab switch.
    if (core.landscape) {
      this.renderSplitView();
    } else {
      this.renderTabbedView();
    }
  }

  private renderTabbedView(): void {
    const core = this.core;
    const { w } = core;

    // Rail itself is now drawn unconditionally by the outer render() dispatcher (see ../SectScene.ts).
    const left = core.railW;

    // Tab bar — starts to the right of the rail, same convention as FamilyScene.
    const tabs: SectTab[] = ['families', 'channel'];
    const tabW = (w - left) / tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]!;
      const active = tab === core.activeTab;
      const tx = left + i * tabW;
      const tabH = 48;
      const tp = sketchPanel(tabW, tabH, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
      tp.x = tx; tp.y = core.headerH;
      core.bodyLayer.addChild(tp);
      const tl = txt(t(tab === 'families' ? 'sect.tabFamilies' : 'sect.tabChannel'), FS.label, active ? C.accent : C.dark);
      tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = core.headerH + tabH / 2;
      core.bodyLayer.addChild(tl);
      core.hitRects.push({ rect: { x: tx, y: core.headerH, w: tabW, h: tabH }, action: () => { core.activeTab = tab; core.scrollY = 0; core.channelStick = true; core.render(); } });
    }

    const contentY = core.headerH + 48;
    const contentH = core.bodyBottom - contentY - 10;

    if (core.activeTab === 'families') {
      this.renderFamilies(contentY, contentH);
    } else {
      this.renderChannel(left, w - left, contentY, contentH, 'scrollY');
    }
  }

  /** Landscape: families roster (left) + sect channel (right) always visible side by side. Sect
   *  identity (name/tag/families/prosperity) + alliance controls live in the header itself now
   *  (see SectSceneCore.drawHeaderTitle) — this used to duplicate them in a hand-drawn band right
   *  below the header, which stacked with the column-title band into a cluttered top-left corner
   *  (see the 25.07.2026 header-declutter pass). */
  private renderSplitView(): void {
    const core = this.core;
    if (!core.sect) return;
    const { w, h } = core;
    const left = core.railW;
    const sect = core.sect;
    const rightEdge = w - 8;

    // Removal vote banner (if a removal is in progress), directly below the header.
    let bannerBottom = core.headerH + 12;
    if (sect.removalVote) {
      const nom = sect.memberFamilies.find(f => f.familyId === sect.removalVote!.nomineeFamilyId);
      const banner = txt(
        t('sect.voteStatus', {
          name: nom ? `[${nom.tag}] ${nom.name}` : sect.removalVote.nomineeFamilyId,
          cur: sect.removalVote.voteCount,
          need: sect.removalVote.needed,
        }),
        FS.body, C.red,
      );
      banner.x = left + 18; banner.y = bannerBottom;
      core.bodyLayer.addChild(banner);
      bannerBottom += Math.round(FS.body * 1.5);
    }

    const colLblSize = FS.label;
    const colLblGap = Math.round(colLblSize * 1.4);
    const contentY = bannerBottom + colLblGap + 4;
    const bottomBarH = 42;
    const contentH = h - contentY - bottomBarH - 8;

    const totalW = w - left;
    const familiesW = Math.round(totalW * 0.5);
    const chatX = left + familiesW + 12;
    const chatW = w - chatX - 8;
    core.chatColX = chatX - 6;

    // Column-title row: a flat tint strip (no hand-drawn border) so it reads as a subtle section
    // divider rather than another decorative panel — matches FamilyScene's renderSplitView.
    const bandY = bannerBottom;
    const bandH = colLblGap + 4;
    const band = new PIXI.Graphics();
    band.beginFill(C.dark, 0.06);
    band.drawRect(left, bandY, rightEdge - left, bandH);
    band.endFill();
    band.lineStyle(1, C.mid, 0.5);
    band.moveTo(left, bandY + bandH).lineTo(rightEdge, bandY + bandH);
    core.bodyLayer.addChild(band);

    const familiesLbl = txt(t('sect.tabFamilies'), colLblSize, C.mid);
    familiesLbl.x = left + 12; familiesLbl.y = bandY + 4;
    core.bodyLayer.addChild(familiesLbl);
    const channelLbl = txt(t('sect.tabChannel'), colLblSize, C.mid);
    channelLbl.x = chatX + 4; channelLbl.y = bandY + 4;
    core.bodyLayer.addChild(channelLbl);

    const divider = new PIXI.Graphics();
    divider.lineStyle(1, C.mid, 0.5);
    divider.moveTo(core.chatColX, bandY).lineTo(core.chatColX, contentY + contentH);
    core.bodyLayer.addChild(divider);

    this.renderFamiliesList(left, familiesW, contentY, contentH, 'scrollY');
    this.renderChannel(chatX, chatW, contentY, contentH, 'scrollYChannel');

    this.renderBottomBar(h - bottomBarH - 4);
  }

  renderFamilies(y0: number, maxH: number): void {
    const core = this.core;
    if (!core.sect) return;
    const { w } = core;
    const left = core.railW;
    const sect = core.sect;

    // Sect summary line (name [tag] · families · prosperity) — plain text directly on the paper.
    // Portrait's narrow header can't fit this on the title bar (landscape lifts it there instead —
    // see SectSceneCore.drawHeaderTitle), so it stays here, but no longer behind a decorative
    // hand-drawn band (see the 25.07.2026 header-declutter pass).
    const summaryH = Math.round(FS.label * 1.6);
    let summaryX = left + 18;

    // Emblem badge (family-emblem-art-prompts.md, 2026-08-14) — same affordance as the landscape
    // header (drawHeaderTitle), just inline at the start of this row for portrait.
    const emblemSize = Math.round(summaryH * 0.9);
    const key = sect.emblemKey as EmblemKey | undefined;
    const emblemNode = key ? buildEmblemIcon(key, emblemSize, sect.emblemColor ?? C.dark) : null;
    if (emblemNode || core.isSectLeader) {
      const badge = emblemNode ?? (() => {
        const ph = new PIXI.Graphics();
        ph.lineStyle(1.4, C.mid, 0.9);
        ph.drawCircle(emblemSize / 2, emblemSize / 2, emblemSize / 2 - 1);
        ph.moveTo(emblemSize * 0.3, emblemSize / 2).lineTo(emblemSize * 0.7, emblemSize / 2);
        ph.moveTo(emblemSize / 2, emblemSize * 0.3).lineTo(emblemSize / 2, emblemSize * 0.7);
        return ph;
      })();
      badge.x = summaryX; badge.y = y0 + (summaryH - emblemSize) / 2;
      core.bodyLayer.addChild(badge);
      if (core.isSectLeader) {
        core.hitRects.push({ rect: { x: badge.x, y: badge.y, w: emblemSize, h: emblemSize }, action: () => core.emblemHooks.openEmblemPicker() });
      }
      summaryX += emblemSize + 8;
    }

    const summary = txt(
      `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
      FS.label, C.dark,
    );
    summary.anchor.set(0, 0.5); summary.x = summaryX; summary.y = y0 + summaryH / 2;
    core.bodyLayer.addChild(summary);
    this.drawAllianceControlsRow(w - 8, y0, summaryH);

    // Removal vote banner.
    let listTop = y0 + summaryH + 8;
    if (sect.removalVote) {
      const nom = sect.memberFamilies.find(f => f.familyId === sect.removalVote!.nomineeFamilyId);
      const banner = txt(
        t('sect.voteStatus', {
          name: nom ? `[${nom.tag}] ${nom.name}` : sect.removalVote.nomineeFamilyId,
          cur: sect.removalVote.voteCount,
          need: sect.removalVote.needed,
        }),
        FS.body, C.red,
      );
      banner.x = left + 18; banner.y = listTop;
      core.bodyLayer.addChild(banner);
      listTop += Math.round(FS.body * 1.5);
    }

    const bottomBarH = 42;
    const viewH = (y0 + maxH - bottomBarH) - listTop;
    this.renderFamiliesList(left, w - left, listTop, viewH, 'scrollY');

    this.renderBottomBar(y0 + maxH - bottomBarH);
  }

  /** Family-list column. `x0`/`colW`/`scrollKey` let this render either full-width (portrait tab)
   *  or as the left half of the landscape split view; `scrollKey` picks which scroll field this
   *  instance owns so the two columns can scroll independently in the split view. Delegates to
   *  lists.ts (2026-08-11, form ① — see claudedocs/client-modules.md's split-form priority note). */
  private renderFamiliesList(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
    renderFamiliesListImpl(this.core, this.actions, x0, colW, y0, maxH, scrollKey);
  }

  renderBottomBar(y: number): void {
    const core = this.core;
    const { w } = core;
    const left = core.railW;
    const midX = (left + w) / 2;
    const bw = 150;
    // Alliance controls (ally / manage allies / allies-view) live in the header in landscape
    // (see SectSceneCore.drawHeaderTitle) or the summary row in portrait (drawAllianceControlsRow).
    // The bottom bar keeps only the leave/dissolve action.
    const busy = core.bt.busy;
    if (core.isSectLeader) {
      this.addBarButton(t('sect.dissolve'), left + 6, y, C.red, () => this.actions.confirmDissolve(), 0, !busy);
    } else if (core.isFamilyLeader) {
      this.addBarButton(t('sect.leave'), midX - bw / 2, y, C.accent, () => this.actions.confirmLeave(), 0, !busy);
    }
  }

  /** Alliance controls seated at the right edge of the portrait summary row (laid out
   *  right-to-left). Landscape draws the equivalent in the header instead — see
   *  SectSceneCore.drawHeaderAllianceButtons. Viewing the ally list is open to every member
   *  (regular members need to know who the sect's allies are); forming (ally) and breaking
   *  (manage allies) alliances stay sect-leader only. */
  private drawAllianceControlsRow(rightEdge: number, bandY: number, bandH: number): void {
    const core = this.core;
    if (!core.sect) return;
    const bh = Math.min(bandH - 4, 32);
    const by = bandY + (bandH - bh) / 2;
    const padX = 14;
    let x = rightEdge - 8; // right anchor; each button is placed to the left of the previous one
    const busy = core.bt.busy;

    const addBtn = (label: string, color: number, action: () => void, seed: number): void => {
      const c = busy ? C.mid : color;
      const lbl = txt(label, FS.tiny, c);
      const bw = Math.ceil(lbl.width) + padX * 2;
      const bx = x - bw;
      const btn = sketchPanel(bw, bh, { fill: 0xf8f8f0, border: c, seed: seedFor(seed, 3, bw) });
      btn.x = bx; btn.y = by;
      core.bodyLayer.addChild(btn);
      lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
      core.bodyLayer.addChild(lbl);
      if (!busy) core.hitRects.push({ rect: { x: bx, y: by, w: bw, h: bh }, action });
      x = bx - 8;
    };

    if (core.isSectLeader) {
      // Rightmost = manage (break), then ally (form) to its left.
      addBtn(t('sect.manageAllies'), C.dark, () => void this.actions.openManageAllies(), 2);
      addBtn(t('sect.ally'), C.accent, () => void this.actions.openAllyList(), 1);
    } else {
      addBtn(t('sect.allies', { n: core.sect.allySectIds.length }), C.accent, () => void this.actions.openAlliesView(), 1);
    }
  }

  /** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderFamiliesList` — see
   *  there. Renders full-width in the portrait tab, or the right half of the landscape split view.
   *  Delegates to lists.ts (2026-08-11, form ① — see claudedocs/client-modules.md's split-form
   *  priority note). */
  renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
    renderChannelImpl(this.core, this.actions, this.input, x0, colW, y0, maxH, scrollKey);
  }

  // ── Small render helpers ────────────────────────────────────────────────────

  centerMessage(msg: string): void {
    const core = this.core;
    const lbl = txt(msg, FS.title, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = core.w / 2; lbl.y = core.h / 2;
    core.bodyLayer.addChild(lbl);
  }

  addCenterButton(label: string, x: number, y: number, action: () => void, seed: number, enabled = true): void {
    const core = this.core;
    const btn = sketchPanel(240, 72, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(seed, 0, 240) });
    btn.x = x; btn.y = y;
    core.bodyLayer.addChild(btn);
    const lbl = txt(label, FS.heading, enabled ? C.light : C.mid);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + 120; lbl.y = y + 36;
    core.bodyLayer.addChild(lbl);
    if (enabled) core.hitRects.push({ rect: { x, y, w: 240, h: 72 }, action });
  }

  addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number, enabled = true): void {
    const core = this.core;
    const bw = 150, bh = 40;
    const c = enabled ? color : C.mid;
    const btn = sketchPanel(bw, bh, { fill: 0xf8f8f0, border: c, seed: seedFor(seed, 2, bw) });
    btn.x = x; btn.y = y;
    core.bodyLayer.addChild(btn);
    const lbl = txt(label, FS.body, c);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = y + bh / 2;
    core.bodyLayer.addChild(lbl);
    if (enabled) core.hitRects.push({ rect: { x, y, w: bw, h: bh }, action });
  }
}
