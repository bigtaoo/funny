// Per-mode rendering for the family scene: loading / noFamily / create form / myFamily (members + channel).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchButton, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { drawChatLine } from '../../render/chatRow';
import { FAMILY_CAP } from '@nw/shared';
import { type Constructor, type FamilySceneBaseCtor, type FamilyTab } from './base';

/** Darker muted ink for secondary family-scene labels. C.mid (0x888888) rendered too faint on the
 *  paper background — this keeps the visual hierarchy (a step below C.dark) while staying legible. */
const MUTED = 0x5a574f;

/** Re-instantiates `txt()` with progressively shorter text (ellipsis) until it fits `maxW`. Narrow
 *  portrait widths + a long family name would otherwise run the name into the member-count label. */
function truncateToWidth(label: string, size: number, color: number, maxW: number): PIXI.Text {
  let s = label;
  let node = txt(s, size, color);
  while (node.width > maxW && s.length > 1) {
    node.destroy();
    s = s.slice(0, -1);
    node = txt(s + '…', size, color);
  }
  return node;
}

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

export interface RenderHandlers {
  renderLoading(): void;
  renderNoFamily(): void;
  renderCreate(): void;
  renderMyFamily(): void;
}

export function RenderMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderLoading(): void {
      const lbl = txt(t('world.loading'), FS.title, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    renderNoFamily(): void {
      const { w, h } = this;
      const lbl = txt(t('family.noFamily'), FS.title, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - h * 0.06;
      this.bodyLayer.addChild(lbl);

      const bw = Math.round(h * 0.16);
      const bh = Math.round(h * 0.055);
      const gap = Math.round(w * 0.01);

      const createBtn = sketchButton(bw, bh, seedFor(0, 0, bw));
      createBtn.x = w / 2 - bw - gap; createBtn.y = h / 2;
      this.bodyLayer.addChild(createBtn);
      const cl = txt(t('family.create'), FS.heading, C.light);
      cl.anchor.set(0.5, 0.5); cl.x = createBtn.x + bw / 2; cl.y = h / 2 + bh / 2;
      this.bodyLayer.addChild(cl);
      this.hitRects.push({ rect: { x: createBtn.x, y: h / 2, w: bw, h: bh }, action: () => { this.mode = 'create'; this.render(); } });

      const joinBtn = sketchButton(bw, bh, seedFor(1, 0, bw));
      joinBtn.x = w / 2 + gap; joinBtn.y = h / 2;
      this.bodyLayer.addChild(joinBtn);
      const jl = txt(t('family.listAll'), FS.heading, C.light);
      jl.anchor.set(0.5, 0.5); jl.x = joinBtn.x + bw / 2; jl.y = h / 2 + bh / 2;
      this.bodyLayer.addChild(jl);
      this.hitRects.push({ rect: { x: joinBtn.x, y: h / 2, w: bw, h: bh }, action: () => void this.openJoinList() });
    }

    renderCreate(): void {
      const { w, h } = this;
      const labelSize = FS.heading;
      const fieldH = Math.round(h * 0.045);
      const fieldX = Math.round(w * 0.16);
      const y1 = this.headerH + Math.round(h * 0.03);
      const y2 = y1 + Math.round(h * 0.07);
      const btnY = y2 + Math.round(h * 0.08);

      const lbl1 = txt(t('family.name') + ':', labelSize, C.dark);
      lbl1.x = 20; lbl1.y = y1 + fieldH / 2 - labelSize / 2;
      this.bodyLayer.addChild(lbl1);

      const nameField = sketchPanel(w - fieldX - 20, fieldH, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - fieldX) });
      nameField.x = fieldX; nameField.y = y1;
      this.bodyLayer.addChild(nameField);
      const nl = txt(caretDisplay(this.createName, this.createField === 'name' && this.caretOn, ' '), FS.heading, C.dark);
      nl.x = fieldX + 8; nl.y = y1 + fieldH / 2 - nl.height / 2;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: fieldX, y: y1, w: w - fieldX - 20, h: fieldH }, action: () => this.openInputFor('name') });

      const lbl2 = txt(t('family.tag') + ':', labelSize, C.dark);
      lbl2.x = 20; lbl2.y = y2 + fieldH / 2 - labelSize / 2;
      this.bodyLayer.addChild(lbl2);

      const tagW = Math.round(w * 0.14);
      const tagField = sketchPanel(tagW, fieldH, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, tagW) });
      tagField.x = fieldX; tagField.y = y2;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, this.createField === 'tag' && this.caretOn, ' '), FS.heading, C.dark);
      tl.x = fieldX + 8; tl.y = y2 + fieldH / 2 - tl.height / 2;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: fieldX, y: y2, w: tagW, h: fieldH }, action: () => this.openInputFor('tag') });

      const hint = txt('[A-Z0-9] 2-5 chars', FS.label, MUTED);
      hint.x = fieldX + tagW + 12; hint.y = y2 + fieldH / 2 - hint.height / 2;
      this.bodyLayer.addChild(hint);

      const okW = Math.round(w * 0.13);
      const btnH = Math.round(h * 0.05);
      const okBtn = sketchButton(okW, btnH, seedFor(0, 0, okW));
      okBtn.x = w / 2 - okW - 10; okBtn.y = btnY;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('family.create'), FS.heading, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = okBtn.x + okW / 2; ok.y = btnY + btnH / 2;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: okBtn.x, y: btnY, w: okW, h: btnH }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(okW, btnH, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, okW) });
      cancelBtn.x = w / 2 + 10; cancelBtn.y = btnY;
      this.bodyLayer.addChild(cancelBtn);
      const caSize = Math.round(btnH * 0.5);
      const ca = buildIcon('close', caSize, C.dark);
      ca.x = cancelBtn.x + okW / 2 - caSize / 2; ca.y = btnY + btnH / 2 - caSize / 2;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: cancelBtn.x, y: btnY, w: okW, h: btnH }, action: () => { this.mode = 'noFamily'; this.render(); } });
    }

    renderMyFamily(): void {
      if (!this.family) return;

      // Landscape has room for both columns permanently side by side (matches how mobile SLG
      // alliance UIs handle this — roster + chat both visible — instead of a tab that leaves
      // whichever side is picked mostly blank when the roster/history is short). Portrait keeps
      // the tab switch since there's no width to spare for two columns.
      if (this.landscape) {
        this.renderSplitView();
      } else {
        this.renderTabbedView();
      }
    }

    private renderTabbedView(): void {
      const { w, h } = this;

      // Rail itself is now drawn unconditionally by the base render() dispatcher (see base.ts).

      // Tab bar — starts to the right of the social hub rail so it doesn't sit on top of it,
      // matching the EquipmentScene/GachaScene convention.
      const left = this.railW;
      const tabH = Math.round(h * 0.05);
      const tabs: FamilyTab[] = ['members', 'channel'];
      const tabW = (w - left) / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tx = left + i * tabW;
        const tp = sketchPanel(tabW, tabH, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = tx; tp.y = this.headerH;
        this.bodyLayer.addChild(tp);
        const tabLabel = t(tab === 'members' ? 'family.tabMembers' : 'family.channel');
        const tl = txt(tabLabel, fitSize(tabLabel, FS.heading, tabW - 16), active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = this.headerH + tabH / 2;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: tx, y: this.headerH, w: tabW, h: tabH }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const infoY = this.headerH + tabH;
      this.renderInfoBand(infoY);

      const contentY = infoY + this.infoBandH;
      const contentH = h - contentY - 6;

      if (this.activeTab === 'members') {
        const btnH = this.renderPendingButton(left, w - left, contentY);
        this.renderMembers(left, w - left, contentY + btnH, contentH - btnH, 'scrollY');
      } else {
        this.renderChannel(left, w - left, contentY, contentH, 'scrollYChannel');
      }
    }

    /** Landscape: roster (left) + family channel (right) always visible side by side. */
    private renderSplitView(): void {
      const { w, h } = this;
      const left = this.railW;

      const infoY = this.headerH + 8;
      this.renderInfoBand(infoY);

      const colLblSize = FS.label;
      const colLblGap = Math.round(colLblSize * 1.4);
      const contentY = infoY + this.infoBandH + colLblGap;
      const contentH = h - contentY - 6;

      const totalW = w - left;
      const rosterW = Math.round(totalW * 0.42);
      const chatX = left + rosterW + 12;
      const chatW = w - chatX - 8;
      this.chatColX = chatX - 6;

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
      this.bodyLayer.addChild(band);

      const membersLbl = txt(t('family.tabMembers'), colLblSize, MUTED);
      membersLbl.x = left + 12; membersLbl.y = contentY - colLblGap;
      this.bodyLayer.addChild(membersLbl);
      const channelLbl = txt(t('family.channel'), colLblSize, MUTED);
      channelLbl.x = chatX + 4; channelLbl.y = contentY - colLblGap;
      this.bodyLayer.addChild(channelLbl);

      const divider = new PIXI.Graphics();
      divider.lineStyle(1, C.mid, 0.5);
      divider.moveTo(this.chatColX, contentY - colLblGap - 4).lineTo(this.chatColX, contentY + contentH);
      this.bodyLayer.addChild(divider);

      const btnH = this.renderPendingButton(left, rosterW, contentY);
      this.renderMembers(left, rosterW, contentY + btnH, contentH - btnH, 'scrollY');
      this.renderChannel(chatX, chatW, contentY, contentH, 'scrollYChannel');
    }

    /** Leader/elder-only "N pending applicants" button shown above the roster when there's at least
     *  one open join request; opens the approve/reject modal (actions.ts openJoinRequests). Returns
     *  the vertical space it consumed (0 when hidden) so callers can shrink the roster area by it. */
    private renderPendingButton(x0: number, colW: number, y: number): number {
      if (!this.isFamilyApprover || this.joinRequests.length === 0) return 0;
      const btnH = Math.round(this.rowH * 0.8);
      const btn = sketchPanel(colW - 12, btnH - 4, { fill: 0xfff3d6, border: 0xd4a030, seed: seedFor(y, 9, colW) });
      btn.x = x0 + 6; btn.y = y + 2;
      this.bodyLayer.addChild(btn);
      const lbl = txt(t('family.pendingRequests', { n: this.joinRequests.length }), FS.bodyLg, 0xa9750f, true);
      lbl.anchor.set(0, 0.5); lbl.x = x0 + 18; lbl.y = y + btnH / 2;
      this.bodyLayer.addChild(lbl);
      const arrow = txt('›', FS.bodyLg, 0xa9750f);
      arrow.anchor.set(1, 0.5); arrow.x = x0 + colW - 20; arrow.y = y + btnH / 2;
      this.bodyLayer.addChild(arrow);
      this.hitRects.push({ rect: { x: x0 + 6, y: y + 2, w: colW - 12, h: btnH - 4 }, action: () => this.openJoinRequests() });
      return btnH;
    }

    /** Family identity band: `[TAG] Name` + member count on row 1, prosperity on row 2, optional
     *  announcement on row 3. Split across rows (rather than one packed line) so a long name or
     *  narrow portrait width can never make more than two labels fight for the same space. */
    private renderInfoBand(y0: number): void {
      if (!this.family) return;
      const { w } = this;
      const left = this.railW;
      const fam = this.family;

      // Landscape: the identity (name/prosperity/count) now lives in the header — here we only
      // surface the announcement, if any, on a slim band below the bar.
      if (this.landscape) {
        if (fam.announcement) {
          const annLbl = truncateToWidth(fam.announcement, FS.label, MUTED, w - (left + 12) - 12);
          annLbl.x = left + 12; annLbl.y = y0 + 4;
          this.bodyLayer.addChild(annLbl);
        }
        return;
      }

      const B = this.infoBandH;

      const countLbl = txt(t('family.memberCount', { n: fam.memberCount, cap: FAMILY_CAP }), FS.label, MUTED);
      countLbl.anchor.set(1, 0); countLbl.x = w - 12; countLbl.y = y0 + Math.round(B * 0.08);
      this.bodyLayer.addChild(countLbl);

      const maxNameW = Math.max(40, w - 12 - (left + 12) - countLbl.width - 16);
      const nameLbl = truncateToWidth(`[${fam.tag}] ${fam.name}`, FS.title, C.dark, maxNameW);
      nameLbl.x = left + 12; nameLbl.y = y0 + Math.round(B * 0.05);
      this.bodyLayer.addChild(nameLbl);

      const starSize = this.fs(0.024);
      const prosY = y0 + Math.round(B * 0.46);
      const star = buildIcon('star', starSize, 0xd4a030);
      star.x = left + 12; star.y = prosY;
      this.bodyLayer.addChild(star);
      const prosLbl = txt(t('family.prosperity', { n: fam.prosperity }), FS.label, 0xa9750f);
      prosLbl.x = left + 12 + starSize + 6; prosLbl.y = prosY - 2;
      this.bodyLayer.addChild(prosLbl);

      if (fam.announcement) {
        const annLbl = truncateToWidth(fam.announcement, FS.label, MUTED, w - (left + 12) - 12);
        annLbl.x = left + 12; annLbl.y = y0 + Math.round(B * 0.78);
        this.bodyLayer.addChild(annLbl);
      }
    }

    /** Roster column. `x0`/`colW` let this render either full-width (portrait tab) or as the
     *  left half of the landscape split view; `scrollKey` picks which scroll field this
     *  instance owns so the two columns can scroll independently in the split view. */
    private renderMembers(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      const right = x0 + colW;
      const me = this.cb.myAccountId;
      const R = this.rowH;

      const myRole = this.members.find(m => m.accountId === me)?.role ?? 'member';
      const isLeader = myRole === 'leader';

      const listH = this.members.length * R;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, listH - maxH)));

      const btnH = Math.round(R * 0.44);
      // Buttons are sized to their (i18n-variable-length) label + padding rather than a fixed width,
      // so "Promote to Elder" / "Demote to Member" no longer clip the way a fixed box would.
      const padX = Math.round(this.h * 0.014);
      const btnGap = Math.round(this.h * 0.01);

      let cy = y0 - this[scrollKey];
      for (const mem of this.members) {
        if (cy + R < y0 || cy > y0 + maxH) { cy += R; continue; }
        const isMe = mem.accountId === me;

        // Per-member card background — my own row is tinted a touch warmer so it stands out.
        const rowBg = sketchPanel(colW - 12, R - 4, { fill: isMe ? 0xefe9d8 : 0xf7f5ee, border: C.mid, seed: seedFor(cy, 5, colW) });
        rowBg.x = x0 + 6; rowBg.y = cy + 2;
        this.bodyLayer.addChild(rowBg);

        const bar = new PIXI.Graphics();
        sketchAccentBar(bar, R - 4, mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : C.mid);
        bar.x = x0 + 6; bar.y = cy + 2;
        this.bodyLayer.addChild(bar);

        // Right-edge buttons, laid out from the right inward, built first so the name can be
        // truncated to stop before them. For other members (when I'm leader): kick + role toggle.
        // For my own row: the Leave / Dissolve action (see below), so it sits at the far right of
        // my name — replacing the old bottom bar.
        const showActions = isLeader && !isMe;
        const btnY = cy + Math.round((R - btnH) / 2);
        let nameRight = right - 12; // where the name column must stop

        if (showActions) {
          const accId = mem.accountId;

          // Members holding an office (elder) can't be kicked directly — the button is greyed
          // out and clicking it just explains that the office must be resigned first, rather
          // than silently doing nothing or letting an elder be kicked with an armed officer role.
          const hasOffice = mem.role === 'elder';
          const kl = txt(t('family.kick'), FS.bodyLg, hasOffice ? MUTED : C.red);
          const kickW = Math.round(kl.width + padX * 2);
          const kx = right - kickW - 8;
          const kickBtn = sketchPanel(kickW, btnH, { fill: hasOffice ? 0xeceae2 : 0xf0e0e0, border: hasOffice ? C.mid : C.red, seed: seedFor(cy, 0, kickW) });
          kickBtn.x = kx; kickBtn.y = btnY;
          this.bodyLayer.addChild(kickBtn);
          kl.anchor.set(0.5, 0.5); kl.x = kx + kickW / 2; kl.y = btnY + btnH / 2;
          this.bodyLayer.addChild(kl);
          this.hitRects.push({
            rect: { x: kx, y: btnY, w: kickW, h: btnH },
            action: () => hasOffice
              ? this.showToast(t('family.kick.needDemoteFirst'), C.dark)
              : this.confirmKick(accId, mem.displayName ?? mem.publicId ?? ''),
          });
          nameRight = kx - btnGap;

          // Role toggle: members → elder, elders → member. (Leader role only changes via transfer/dissolve.)
          if (mem.role !== 'leader') {
            const toElder = mem.role === 'member';
            const rl = txt(t(toElder ? 'family.setElder' : 'family.setMember'), FS.bodyLg, 0xa9750f);
            const roleW = Math.round(rl.width + padX * 2);
            const bx = kx - btnGap - roleW;
            const roleBtn = sketchPanel(roleW, btnH, { fill: 0xeef0e0, border: 0xd4a030, seed: seedFor(cy, 2, roleW) });
            roleBtn.x = bx; roleBtn.y = btnY;
            this.bodyLayer.addChild(roleBtn);
            rl.anchor.set(0.5, 0.5); rl.x = bx + roleW / 2; rl.y = btnY + btnH / 2;
            this.bodyLayer.addChild(rl);
            const nextRole: 'elder' | 'member' = toElder ? 'elder' : 'member';
            this.hitRects.push({ rect: { x: bx, y: btnY, w: roleW, h: btnH }, action: () => void this.doSetRole(accId, nextRole) });
            nameRight = bx - btnGap;
          }
        } else if (isMe) {
          // Leave / Dissolve on my own row. A leader may only Dissolve, and only once they are the
          // sole member — while others remain they can neither leave nor dissolve (must transfer or
          // kick first). Everyone else gets Leave Family.
          const alone = this.members.length === 1;
          if (!isLeader || alone) {
            const dissolve = isLeader && alone;
            const al = txt(t(dissolve ? 'family.dissolve' : 'family.leave'), FS.bodyLg, dissolve ? C.red : C.accent);
            const aw = Math.round(al.width + padX * 2);
            const ax = right - aw - 8;
            const aBtn = sketchPanel(aw, btnH, { fill: 0xf8f8f0, border: dissolve ? C.red : C.accent, seed: seedFor(cy, 3, aw) });
            aBtn.x = ax; aBtn.y = btnY;
            this.bodyLayer.addChild(aBtn);
            al.anchor.set(0.5, 0.5); al.x = ax + aw / 2; al.y = btnY + btnH / 2;
            this.bodyLayer.addChild(al);
            this.hitRects.push({ rect: { x: ax, y: btnY, w: aw, h: btnH }, action: () => dissolve ? this.confirmDissolve() : this.confirmLeave() });
            nameRight = ax - btnGap;
          }
        }

        // Name on the left, with the role label immediately to its right (was stacked above it).
        const roleColor = mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : MUTED;
        const roleLbl = txt(t(`family.${mem.role as 'leader' | 'member' | 'elder'}`), FS.bodyLg, roleColor);
        const nameMaxW = Math.max(40, nameRight - (x0 + 18) - roleLbl.width - 10);
        const nameLbl = truncateToWidth(mem.displayName ?? mem.publicId ?? '', FS.heading, C.dark, nameMaxW);
        nameLbl.x = x0 + 18; nameLbl.y = cy + Math.round((R - nameLbl.height) / 2);
        this.bodyLayer.addChild(nameLbl);
        roleLbl.x = nameLbl.x + nameLbl.width + 10; roleLbl.y = cy + Math.round((R - roleLbl.height) / 2);
        this.bodyLayer.addChild(roleLbl);

        cy += R;
      }

      // Vacancy hint: turns the leftover space below a small roster into information ("room to
      // grow") instead of dead whitespace, without implying an invite feature that doesn't exist yet.
      const vacancies = FAMILY_CAP - this.members.length;
      if (vacancies > 0 && cy + 20 < y0 + maxH) {
        const vacLbl = txt(t('family.vacancies', { n: vacancies }), FS.label, MUTED);
        vacLbl.alpha = 0.75;
        vacLbl.x = x0 + 18; vacLbl.y = cy + Math.round(R * 0.2);
        this.bodyLayer.addChild(vacLbl);
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: maxH }, this[scrollKey], Math.max(0, listH - maxH));
    }

    /** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderMembers` — see there. */
    private renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      const right = x0 + colW;
      const R = this.rowH;
      const inputH = Math.round(this.h * 0.05);
      const listH2 = maxH - inputH - 6;

      // Message list
      const msgH = this.messages.length * R;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, msgH - listH2)));

      let cy = y0 - this[scrollKey];
      for (const msg of this.messages) {
        if (cy + R < y0 || cy > y0 + listH2) { cy += R; continue; }
        drawChatLine(
          this.bodyLayer, x0 + 12, cy + R / 2,
          { senderName: msg.senderName ?? msg.senderId, title: msg.title, familyName: msg.familyName },
          msg.body, FS.label, FS.label,
        );
        cy += R;
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: listH2 }, this[scrollKey], Math.max(0, msgH - listH2));

      if (this.messages.length === 0) {
        const emptyLbl = txt(t('family.noMessages'), FS.label, MUTED);
        emptyLbl.alpha = 0.8;
        emptyLbl.x = x0 + 12; emptyLbl.y = y0 + 8;
        this.bodyLayer.addChild(emptyLbl);
      }

      // Input area
      const inputY = y0 + listH2 + 4;
      const sendW = Math.round(this.h * 0.09);
      const fieldW = right - x0 - sendW - 12;
      const active = this.sendInput !== null;
      const field = sketchPanel(fieldW, inputH, { fill: 0xfaf9f5, border: active ? C.accent : C.mid, seed: seedFor(0, 0, fieldW) });
      field.x = x0 + 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      // Show the typed text (+ blinking caret while focused); fall back to the placeholder when empty.
      const hasText = this.sendText.length > 0;
      const fl = txt(caretDisplay(this.sendText, active && this.caretOn, t('family.msgPlaceholder')), FS.label, hasText ? C.dark : MUTED);
      fl.x = x0 + 12; fl.y = inputY + inputH / 2 - fl.height / 2;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: inputH }, action: () => this.openSendInput() });

      const sendBtn = sketchButton(sendW, inputH, seedFor(1, 0, sendW));
      sendBtn.x = right - sendW; sendBtn.y = inputY;
      this.bodyLayer.addChild(sendBtn);
      const sl = txt(t('family.send'), FS.heading, C.light);
      sl.anchor.set(0.5, 0.5); sl.x = right - sendW / 2; sl.y = inputY + inputH / 2;
      this.bodyLayer.addChild(sl);
      this.hitRects.push({ rect: { x: right - sendW, y: inputY, w: sendW, h: inputH }, action: () => void this.doSendMsg() });
    }
  };
}
