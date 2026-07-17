// Render domain: the mode-specific views (loading / no-sect / create form / my-sect with the
// families + channel tabs) plus the small center-message / center-button / bottom-bar-button helpers.
import * as PIXI from 'pixi.js-legacy';
import { SECT_CREATE_COST } from '@nw/shared';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { caretDisplay } from '../../render/inputDisplay';
import { drawChatLine } from '../../render/chatRow';
import { type Constructor, type SectSceneBaseCtor, type SectTab, ROW_H } from './base';
import { FS } from '../../render/fontScale';

export interface RenderHandlers {
  renderLoading(): void;
  renderNoSect(): void;
  renderCreate(): void;
  renderMySect(): void;
  renderFamilies(y0: number, maxH: number): void;
  renderBottomBar(y: number): void;
  renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void;
  centerMessage(msg: string): void;
  addCenterButton(label: string, x: number, y: number, action: () => void, seed: number, enabled?: boolean): void;
  addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number): void;
}

export function RenderMixin<TBase extends SectSceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderLoading(): void {
      const lbl = txt(t('world.loading'), FS.title, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    renderNoSect(): void {
      const { w, h } = this;

      // Players who aren't a family leader can't act on the sect.
      if (!this.inFamily) {
        this.centerMessage(t('sect.notInFamily'));
        return;
      }
      if (!this.isFamilyLeader) {
        this.centerMessage(t('sect.notLeader'));
        return;
      }

      const lbl = txt(t('sect.noSect'), FS.heading, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - 100;
      this.bodyLayer.addChild(lbl);

      const hint = txt(t('sect.createHint', { n: SECT_CREATE_COST }), FS.label, C.mid);
      hint.anchor.set(0.5, 0.5);
      hint.x = w / 2; hint.y = h / 2 - 56;
      this.bodyLayer.addChild(hint);

      const canAffordCreate = this.cb.getCoins() >= SECT_CREATE_COST;
      this.addCenterButton(
        t('sect.create'), w / 2 - 260, h / 2,
        () => { this.mode = 'create'; this.render(); },
        0, canAffordCreate,
      );
      this.addCenterButton(t('sect.browse'), w / 2 + 20, h / 2, () => void this.openBrowseList(), 1);
    }

    renderCreate(): void {
      const { w, h } = this;

      // Whole create-form is scaled up uniformly (constants + fonts) by S so it reads larger
      // without touching the global font scale. Every geometry value below is pre-multiplied.
      const S = 1.3;

      // Everything lives inside a centered card in the region RIGHT of the social rail — the
      // old absolute-x layout overlapped the rail (Family/Sect/World/Mail) and the header text.
      const left = this.railW;
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
      const cardY = Math.max(this.headerH + 20, this.headerH + (h - this.headerH - cardH) / 2);

      // Card background.
      const card = sketchPanel(cardW, cardH, { fill: C.paper, border: C.mid, seed: seedFor(7, 0, cardW) });
      card.x = cardX; card.y = cardY;
      this.bodyLayer.addChild(card);

      let y = cardY + pad;

      // Title.
      const title = txt(t('sect.createTitle'), FS.label * S, C.dark);
      title.anchor.set(0.5, 0); title.x = cx; title.y = y;
      this.bodyLayer.addChild(title);
      y += titleH + gapAfterTitle;

      // ── Sect name ──
      const nameLbl = txt(t('sect.name'), FS.body * S, C.dark);
      nameLbl.x = inX; nameLbl.y = y;
      this.bodyLayer.addChild(nameLbl);
      y += labelH + gapLabelField;

      const nameFocused = this.createField === 'name';
      const nameField = sketchPanel(inW, fieldH, { fill: 0xfaf9f5, border: nameFocused ? C.accent : C.mid, seed: seedFor(0, 0, inW) });
      nameField.x = inX; nameField.y = y;
      this.bodyLayer.addChild(nameField);
      const nameEmpty = this.createName.length === 0 && !nameFocused;
      const nl = txt(nameEmpty ? t('social.sect.namePlaceholder') : caretDisplay(this.createName, nameFocused && this.caretOn, ' '), FS.bodyLg * S, nameEmpty ? C.mid : C.dark);
      nl.anchor.set(0, 0.5); nl.x = inX + 12 * S; nl.y = y + fieldH / 2;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: inX, y, w: inW, h: fieldH }, action: () => this.openInputFor('name') });
      y += fieldH + gapAfterName;

      // ── Tag (short label + hint line underneath) ──
      const tagLbl = txt(t('sect.tagLabel'), FS.body * S, C.dark);
      tagLbl.x = inX; tagLbl.y = y;
      this.bodyLayer.addChild(tagLbl);
      y += tagLabelH;
      const tagHint = txt(t('sect.tagHint'), FS.tiny * S, C.mid);
      tagHint.x = inX; tagHint.y = y;
      this.bodyLayer.addChild(tagHint);
      y += tagHintH;

      const tagFocused = this.createField === 'tag';
      const tagField = sketchPanel(tagFieldW, fieldH, { fill: 0xfaf9f5, border: tagFocused ? C.accent : C.mid, seed: seedFor(1, 0, tagFieldW) });
      tagField.x = inX; tagField.y = y;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, tagFocused && this.caretOn, ' '), FS.bodyLg * S, C.dark);
      tl.anchor.set(0, 0.5); tl.x = inX + 12 * S; tl.y = y + fieldH / 2;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: inX, y, w: tagFieldW, h: fieldH }, action: () => this.openInputFor('tag') });
      y += fieldH + gapAfterTag;

      // ── Buttons (create + cancel, side by side, centered under the fields) ──
      const btnW = 150 * S, btnGap = 24 * S;
      const okX = cx - btnW - btnGap / 2;
      const cancelX = cx + btnGap / 2;

      const okBtn = sketchButton(btnW, btnH, seedFor(0, 1, btnW));
      okBtn.x = okX; okBtn.y = y;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('sect.create'), FS.body * S, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = okX + btnW / 2; ok.y = y + btnH / 2;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: okX, y, w: btnW, h: btnH }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(btnW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 1, btnW) });
      cancelBtn.x = cancelX; cancelBtn.y = y;
      this.bodyLayer.addChild(cancelBtn);
      const ca = txt(t('social.sect.cancel'), FS.body * S, C.dark);
      ca.anchor.set(0.5, 0.5); ca.x = cancelX + btnW / 2; ca.y = y + btnH / 2;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: cancelX, y, w: btnW, h: btnH }, action: () => { this.mode = 'noSect'; this.render(); } });
    }

    renderMySect(): void {
      if (!this.sect) return;
      // Landscape has room for both columns permanently side by side (matches FamilyScene) — a tab
      // switch left whichever side wasn't selected mostly blank. Portrait keeps the tab switch.
      if (this.landscape) {
        this.renderSplitView();
      } else {
        this.renderTabbedView();
      }
    }

    private renderTabbedView(): void {
      const { w, h } = this;

      // Rail itself is now drawn unconditionally by the base render() dispatcher (see base.ts).
      const left = this.railW;

      // Tab bar — starts to the right of the rail, same convention as FamilyScene.
      const tabs: SectTab[] = ['families', 'channel'];
      const tabW = (w - left) / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tx = left + i * tabW;
        const tabH = 48;
        const tp = sketchPanel(tabW, tabH, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = tx; tp.y = this.headerH;
        this.bodyLayer.addChild(tp);
        const tl = txt(t(tab === 'families' ? 'sect.tabFamilies' : 'sect.tabChannel'), FS.label, active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = this.headerH + tabH / 2;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: tx, y: this.headerH, w: tabW, h: tabH }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const contentY = this.headerH + 48;
      const contentH = h - contentY - 10;

      if (this.activeTab === 'families') {
        this.renderFamilies(contentY, contentH);
      } else {
        this.renderChannel(left, w - left, contentY, contentH, 'scrollY');
      }
    }

    /** Landscape: families roster (left) + sect channel (right) always visible side by side. */
    private renderSplitView(): void {
      if (!this.sect) return;
      const { w, h } = this;
      const left = this.railW;
      const sect = this.sect;
      const rightEdge = w - 8;

      // Sect summary line (name [tag] · families · prosperity), full width across the top, seated on
      // a header band that it shares (same style) with the column-title row below.
      const summaryY = this.headerH + 12;
      const summaryH = Math.round(FS.label * 1.6);
      this.drawHeaderBand(left + 6, summaryY, rightEdge - (left + 6), summaryH);
      const summary = txt(
        `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
        FS.label, C.dark,
      );
      summary.anchor.set(0, 0.5); summary.x = left + 18; summary.y = summaryY + summaryH / 2;
      this.bodyLayer.addChild(summary);

      // Removal vote banner (if a removal is in progress).
      let bannerBottom = summaryY + summaryH + 8;
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
        this.bodyLayer.addChild(banner);
        bannerBottom += Math.round(FS.body * 1.5);
      }

      const colLblSize = FS.label;
      const colLblBandH = Math.round(colLblSize * 1.5);
      const contentY = bannerBottom + colLblBandH + 6;
      const bottomBarH = 42;
      const contentH = h - contentY - bottomBarH - 8;

      const totalW = w - left;
      const familiesW = Math.round(totalW * 0.5);
      const chatX = left + familiesW + 12;
      const chatW = w - chatX - 8;
      this.chatColX = chatX - 6;

      // Column-title row — shares the same header-band background as the sect-name row above.
      const colBandY = bannerBottom;
      this.drawHeaderBand(left + 6, colBandY, rightEdge - (left + 6), colLblBandH);
      const familiesLbl = txt(t('sect.tabFamilies'), colLblSize, C.dark);
      familiesLbl.anchor.set(0, 0.5); familiesLbl.x = left + 18; familiesLbl.y = colBandY + colLblBandH / 2;
      this.bodyLayer.addChild(familiesLbl);
      const channelLbl = txt(t('sect.tabChannel'), colLblSize, C.dark);
      channelLbl.anchor.set(0, 0.5); channelLbl.x = chatX + 6; channelLbl.y = colBandY + colLblBandH / 2;
      this.bodyLayer.addChild(channelLbl);

      const divider = new PIXI.Graphics();
      divider.lineStyle(1, C.mid, 0.5);
      divider.moveTo(this.chatColX, contentY - 4).lineTo(this.chatColX, contentY + contentH);
      this.bodyLayer.addChild(divider);

      this.renderFamiliesList(left, familiesW, contentY, contentH, 'scrollY');
      this.renderChannel(chatX, chatW, contentY, contentH, 'scrollYChannel');

      this.renderBottomBar(h - bottomBarH - 4);
    }

    /** Subtle hand-drawn header band shared by the sect-name row and the column-title row so they
     *  read as one unified header strip (rather than labels floating on the ruled paper). */
    private drawHeaderBand(x: number, y: number, bandW: number, bandH: number): void {
      const band = sketchPanel(bandW, bandH, { fill: 0xf0ece2, border: C.mid, seed: seedFor(9, Math.round(y), bandW) });
      band.x = x; band.y = y;
      this.bodyLayer.addChild(band);
    }

    renderFamilies(y0: number, maxH: number): void {
      if (!this.sect) return;
      const { w } = this;
      const left = this.railW;
      const sect = this.sect;

      // Sect summary line (name [tag] · families · prosperity), on the shared header band.
      const summaryH = Math.round(FS.label * 1.6);
      this.drawHeaderBand(left + 6, y0, (w - 8) - (left + 6), summaryH);
      const summary = txt(
        `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
        FS.label, C.dark,
      );
      summary.anchor.set(0, 0.5); summary.x = left + 18; summary.y = y0 + summaryH / 2;
      this.bodyLayer.addChild(summary);

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
        this.bodyLayer.addChild(banner);
        listTop += Math.round(FS.body * 1.5);
      }

      const bottomBarH = 42;
      const viewH = (y0 + maxH - bottomBarH) - listTop;
      this.renderFamiliesList(left, w - left, listTop, viewH, 'scrollY');

      this.renderBottomBar(y0 + maxH - bottomBarH);
    }

    /** Family-list column. `x0`/`colW`/`scrollKey` let this render either full-width (portrait tab)
     *  or as the left half of the landscape split view; `scrollKey` picks which scroll field this
     *  instance owns so the two columns can scroll independently in the split view. */
    private renderFamiliesList(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      if (!this.sect) return;
      const sect = this.sect;
      const right = x0 + colW;

      const listH = sect.memberFamilies.length * ROW_H;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, listH - maxH)));

      let cy = y0 - this[scrollKey];
      for (const fam of sect.memberFamilies) {
        if (cy + ROW_H >= y0 && cy <= y0 + maxH) {
          const isLeaderFam = fam.familyId === sect.leaderFamilyId;
          const bar = new PIXI.Graphics();
          sketchAccentBar(bar, ROW_H - 6, isLeaderFam ? C.accent : C.mid);
          bar.x = x0 + 6; bar.y = cy + 3;
          this.bodyLayer.addChild(bar);

          // Row 1: family name, with the "Leader family" tag inline to its right.
          const nameLbl = txt(`[${fam.tag}] ${fam.name}`, FS.heading, C.dark);
          nameLbl.x = x0 + 18; nameLbl.y = cy + 8;
          this.bodyLayer.addChild(nameLbl);
          if (isLeaderFam) {
            const ldr = txt(t('sect.leaderFamily'), FS.small, C.accent);
            ldr.anchor.set(0, 0.5); ldr.x = nameLbl.x + nameLbl.width + 12; ldr.y = cy + 8 + nameLbl.height / 2;
            this.bodyLayer.addChild(ldr);
          }
          // Row 2: member / territory counts.
          const statLbl = txt(`${t('family.members', { n: fam.memberCount })} · ${t('sect.territory', { n: fam.territoryCount })}`, FS.body, C.mid);
          statLbl.x = x0 + 18; statLbl.y = cy + 8 + nameLbl.height + 6;
          this.bodyLayer.addChild(statLbl);

          // Any family leader (except the current leader family) can launch / vote a removal.
          if (this.isFamilyLeader && !isLeaderFam) {
            const voteW = 104, voteBtnX = right - voteW - 12;
            const voteBtn = sketchPanel(voteW, 34, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 1, voteW) });
            voteBtn.x = voteBtnX; voteBtn.y = cy + (ROW_H - 34) / 2;
            this.bodyLayer.addChild(voteBtn);
            const vl = txt(t('sect.vote'), FS.body, C.red);
            vl.anchor.set(0.5, 0.5); vl.x = voteBtnX + voteW / 2; vl.y = cy + ROW_H / 2;
            this.bodyLayer.addChild(vl);
            const nomId = fam.familyId;
            const nomLabel = `[${fam.tag}] ${fam.name}`;
            this.hitRects.push({ rect: { x: voteBtnX, y: cy + (ROW_H - 34) / 2, w: voteW, h: 34 }, action: () => this.confirmVote(nomId, nomLabel) });
          }
        }
        cy += ROW_H;
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: maxH }, this[scrollKey], Math.max(0, listH - maxH));
    }

    renderBottomBar(y: number): void {
      const { w } = this;
      const left = this.railW;
      const midX = (left + w) / 2;
      const bw = 150;
      if (this.isSectLeader) {
        // Leader: dissolve / ally / manage allies.
        this.addBarButton(t('sect.dissolve'), left + 6, y, C.red, () => this.confirmDissolve(), 0);
        this.addBarButton(t('sect.ally'), midX - bw / 2, y, C.accent, () => void this.openAllyList(), 1);
        this.addBarButton(t('sect.manageAllies'), w - bw - 8, y, C.dark, () => void this.openManageAllies(), 2);
      } else if (this.isFamilyLeader) {
        this.addBarButton(t('sect.leave'), midX - bw / 2, y, C.accent, () => this.confirmLeave(), 0);
      }
    }

    /** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderFamiliesList` — see
     *  there. Renders full-width in the portrait tab, or the right half of the landscape split view. */
    renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      const right = x0 + colW;
      const inputH = 52;
      const listH2 = maxH - inputH - 6;

      if (this.messages.length === 0) {
        const empty = txt(t('sect.noMessages'), FS.label, C.mid);
        empty.anchor.set(0.5, 0); empty.x = x0 + colW / 2; empty.y = y0 + 8;
        this.bodyLayer.addChild(empty);
      }

      const msgH = this.messages.length * ROW_H;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, msgH - listH2)));

      // Channel is returned newest-first; render oldest-at-top for natural reading.
      const ordered = [...this.messages].reverse();
      let cy = y0 - this[scrollKey];
      for (const msg of ordered) {
        if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
        drawChatLine(
          this.bodyLayer, x0 + 12, cy + ROW_H / 2,
          { senderName: msg.senderName, title: msg.title, sectName: msg.sectName, familyName: msg.familyName },
          msg.body, FS.label, FS.label,
        );
        cy += ROW_H;
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: listH2 }, this[scrollKey], Math.max(0, msgH - listH2));

      const inputY = y0 + listH2 + 4;
      const sendW = 96;
      const fieldW = colW - sendW - 12;
      const field = sketchPanel(fieldW, inputH, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, fieldW) });
      field.x = x0 + 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      const fl = txt(t('sect.msgPlaceholder'), FS.label, C.mid);
      fl.anchor.set(0, 0.5); fl.x = x0 + 12; fl.y = inputY + inputH / 2;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: inputH }, action: () => this.openSendInput() });

      const sendBtn = sketchButton(sendW, inputH, seedFor(1, 0, sendW));
      sendBtn.x = right - sendW; sendBtn.y = inputY;
      this.bodyLayer.addChild(sendBtn);
      const sl = txt(t('sect.send'), FS.heading, C.light);
      sl.anchor.set(0.5, 0.5); sl.x = right - sendW / 2; sl.y = inputY + inputH / 2;
      this.bodyLayer.addChild(sl);
      this.hitRects.push({ rect: { x: right - sendW, y: inputY, w: sendW, h: inputH }, action: () => this.openSendInput() });
    }

    // ── Small render helpers ────────────────────────────────────────────────────

    centerMessage(msg: string): void {
      const lbl = txt(msg, FS.title, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    addCenterButton(label: string, x: number, y: number, action: () => void, seed: number, enabled = true): void {
      const btn = sketchPanel(240, 72, { fill: enabled ? C.dark : C.btnOff, border: enabled ? C.accent : C.mid, seed: seedFor(seed, 0, 240) });
      btn.x = x; btn.y = y;
      this.bodyLayer.addChild(btn);
      const lbl = txt(label, FS.heading, enabled ? C.light : C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + 120; lbl.y = y + 36;
      this.bodyLayer.addChild(lbl);
      if (enabled) this.hitRects.push({ rect: { x, y, w: 240, h: 72 }, action });
    }

    addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number): void {
      const bw = 150, bh = 40;
      const btn = sketchPanel(bw, bh, { fill: 0xf8f8f0, border: color, seed: seedFor(seed, 2, bw) });
      btn.x = x; btn.y = y;
      this.bodyLayer.addChild(btn);
      const lbl = txt(label, FS.body, color);
      lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = y + bh / 2;
      this.bodyLayer.addChild(lbl);
      this.hitRects.push({ rect: { x, y, w: bw, h: bh }, action });
    }
  };
}
