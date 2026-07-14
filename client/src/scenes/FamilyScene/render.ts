// Per-mode rendering for the family scene: loading / noFamily / create form / myFamily (members + channel).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor } from '../../render/sketchUi';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { buildIcon } from '../../render/icons';
import { caretDisplay } from '../../render/inputDisplay';
import { FAMILY_CAP } from '@nw/shared';
import { type Constructor, type FamilySceneBaseCtor, type FamilyTab, ROW_H } from './base';

/** Height of the family info band (name/count row + prosperity row + optional announcement row). */
const INFO_BAND_H = 54;

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

export interface RenderHandlers {
  renderLoading(): void;
  renderNoFamily(): void;
  renderCreate(): void;
  renderMyFamily(): void;
}

export function RenderMixin<TBase extends FamilySceneBaseCtor>(Base: TBase): TBase & Constructor<RenderHandlers> {
  return class extends Base {
    renderLoading(): void {
      const lbl = txt(t('world.loading'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = this.w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
    }

    renderNoFamily(): void {
      const { w, h } = this;
      const lbl = txt(t('family.noFamily'), 14, C.dark);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2 - 40;
      this.bodyLayer.addChild(lbl);

      const createBtn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 120) });
      createBtn.x = w / 2 - 130; createBtn.y = h / 2;
      this.bodyLayer.addChild(createBtn);
      const cl = txt(t('family.create'), 13, C.light);
      cl.anchor.set(0.5, 0.5); cl.x = w / 2 - 70; cl.y = h / 2 + 18;
      this.bodyLayer.addChild(cl);
      this.hitRects.push({ rect: { x: w / 2 - 130, y: h / 2, w: 120, h: 36 }, action: () => { this.mode = 'create'; this.render(); } });

      const joinBtn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 120) });
      joinBtn.x = w / 2 + 10; joinBtn.y = h / 2;
      this.bodyLayer.addChild(joinBtn);
      const jl = txt(t('family.listAll'), 13, C.light);
      jl.anchor.set(0.5, 0.5); jl.x = w / 2 + 70; jl.y = h / 2 + 18;
      this.bodyLayer.addChild(jl);
      this.hitRects.push({ rect: { x: w / 2 + 10, y: h / 2, w: 120, h: 36 }, action: () => void this.openJoinList() });
    }

    renderCreate(): void {
      const { w, h } = this;

      const lbl1 = txt(t('family.name') + ':', 13, C.dark);
      lbl1.x = 20; lbl1.y = this.headerH + 20;
      this.bodyLayer.addChild(lbl1);

      const nameField = sketchPanel(w - 120, 32, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - 120) });
      nameField.x = 100; nameField.y = this.headerH + 14;
      this.bodyLayer.addChild(nameField);
      const nl = txt(caretDisplay(this.createName, this.createField === 'name' && this.caretOn, ' '), 13, C.dark);
      nl.x = 108; nl.y = this.headerH + 22;
      this.bodyLayer.addChild(nl);
      this.hitRects.push({ rect: { x: 100, y: this.headerH + 14, w: w - 120, h: 32 }, action: () => this.openInputFor('name') });

      const lbl2 = txt(t('family.tag') + ':', 13, C.dark);
      lbl2.x = 20; lbl2.y = this.headerH + 70;
      this.bodyLayer.addChild(lbl2);

      const tagField = sketchPanel(100, 32, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, 100) });
      tagField.x = 100; tagField.y = this.headerH + 64;
      this.bodyLayer.addChild(tagField);
      const tl = txt(caretDisplay(this.createTag, this.createField === 'tag' && this.caretOn, ' '), 13, C.dark);
      tl.x = 108; tl.y = this.headerH + 72;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: 100, y: this.headerH + 64, w: 100, h: 32 }, action: () => this.openInputFor('tag') });

      const hint = txt('[A-Z0-9] 2-5 chars', 11, C.mid);
      hint.x = 210; hint.y = this.headerH + 72;
      this.bodyLayer.addChild(hint);

      const okBtn = sketchPanel(100, 34, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 100) });
      okBtn.x = w / 2 - 110; okBtn.y = this.headerH + 120;
      this.bodyLayer.addChild(okBtn);
      const ok = txt(t('family.create'), 13, C.light);
      ok.anchor.set(0.5, 0.5); ok.x = w / 2 - 60; ok.y = this.headerH + 137;
      this.bodyLayer.addChild(ok);
      this.hitRects.push({ rect: { x: w / 2 - 110, y: this.headerH + 120, w: 100, h: 34 }, action: () => void this.doCreate() });

      const cancelBtn = sketchPanel(100, 34, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, 100) });
      cancelBtn.x = w / 2 + 10; cancelBtn.y = this.headerH + 120;
      this.bodyLayer.addChild(cancelBtn);
      const ca = buildIcon('close', 15, C.dark);
      ca.x = w / 2 + 60 - 7.5; ca.y = this.headerH + 137 - 7.5;
      this.bodyLayer.addChild(ca);
      this.hitRects.push({ rect: { x: w / 2 + 10, y: this.headerH + 120, w: 100, h: 34 }, action: () => { this.mode = 'noFamily'; this.render(); } });
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
      const tabs: FamilyTab[] = ['members', 'channel'];
      const tabW = (w - left) / tabs.length;
      for (let i = 0; i < tabs.length; i++) {
        const tab = tabs[i]!;
        const active = tab === this.activeTab;
        const tx = left + i * tabW;
        const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
        tp.x = tx; tp.y = this.headerH;
        this.bodyLayer.addChild(tp);
        const tl = txt(t(tab === 'members' ? 'family.tabMembers' : 'family.channel'), 13, active ? C.accent : C.dark);
        tl.anchor.set(0.5, 0.5); tl.x = tx + tabW / 2; tl.y = this.headerH + 18;
        this.bodyLayer.addChild(tl);
        this.hitRects.push({ rect: { x: tx, y: this.headerH, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
      }

      const infoY = this.headerH + 36;
      this.renderInfoBand(infoY);

      const contentY = infoY + INFO_BAND_H;
      const barH = 44;
      const contentH = h - contentY - barH - 6;

      if (this.activeTab === 'members') {
        this.renderMembers(left, w - left, contentY, contentH, 'scrollY');
      } else {
        this.renderChannel(left, w - left, contentY, contentH, 'scrollYChannel');
      }
      this.renderBottomBar(left, w, contentY + contentH + 6);
    }

    /** Landscape: roster (left) + family channel (right) always visible side by side. */
    private renderSplitView(): void {
      const { w, h } = this;
      const left = this.railW;

      const infoY = this.headerH + 8;
      this.renderInfoBand(infoY);

      const barH = 44;
      const contentY = infoY + INFO_BAND_H + 18;
      const contentH = h - contentY - barH - 6;

      const totalW = w - left;
      const rosterW = Math.round(totalW * 0.42);
      const chatX = left + rosterW + 12;
      const chatW = w - chatX - 8;
      this.chatColX = chatX - 6;

      const membersLbl = txt(t('family.tabMembers'), 12, C.mid);
      membersLbl.x = left + 12; membersLbl.y = contentY - 18;
      this.bodyLayer.addChild(membersLbl);
      const channelLbl = txt(t('family.channel'), 12, C.mid);
      channelLbl.x = chatX + 4; channelLbl.y = contentY - 18;
      this.bodyLayer.addChild(channelLbl);

      const divider = new PIXI.Graphics();
      divider.lineStyle(1, C.mid, 0.5);
      divider.moveTo(this.chatColX, contentY - 22).lineTo(this.chatColX, contentY + contentH);
      this.bodyLayer.addChild(divider);

      this.renderMembers(left, rosterW, contentY, contentH, 'scrollY');
      this.renderChannel(chatX, chatW, contentY, contentH, 'scrollYChannel');
      this.renderBottomBar(left, w, contentY + contentH + 6);
    }

    /** Family identity band: `[TAG] Name` + member count on row 1, prosperity on row 2, optional
     *  announcement on row 3. Split across rows (rather than one packed line) so a long name or
     *  narrow portrait width can never make more than two labels fight for the same space. */
    private renderInfoBand(y0: number): void {
      if (!this.family) return;
      const { w } = this;
      const left = this.railW;
      const fam = this.family;

      const countLbl = txt(t('family.memberCount', { n: fam.memberCount, cap: FAMILY_CAP }), 12, C.mid);
      countLbl.anchor.set(1, 0); countLbl.x = w - 12; countLbl.y = y0 + 5;
      this.bodyLayer.addChild(countLbl);

      const maxNameW = Math.max(40, w - 12 - (left + 12) - countLbl.width - 16);
      const nameLbl = truncateToWidth(`[${fam.tag}] ${fam.name}`, 15, C.dark, maxNameW);
      nameLbl.x = left + 12; nameLbl.y = y0 + 4;
      this.bodyLayer.addChild(nameLbl);

      const star = buildIcon('star', 13, 0xd4a030);
      star.x = left + 12; star.y = y0 + 22;
      this.bodyLayer.addChild(star);
      const prosLbl = txt(t('family.prosperity', { n: fam.prosperity }), 12, 0xb8881a);
      prosLbl.x = left + 30; prosLbl.y = y0 + 21;
      this.bodyLayer.addChild(prosLbl);

      if (fam.announcement) {
        const annLbl = txt(fam.announcement, 11, C.mid);
        annLbl.x = left + 12; annLbl.y = y0 + 38;
        this.bodyLayer.addChild(annLbl);
      }
    }

    /** Roster column. `x0`/`colW` let this render either full-width (portrait tab) or as the
     *  left half of the landscape split view; `scrollKey` picks which scroll field this
     *  instance owns so the two columns can scroll independently in the split view. */
    private renderMembers(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      const right = x0 + colW;
      const me = this.cb.myAccountId;

      const myRole = this.members.find(m => m.accountId === me)?.role ?? 'member';
      const isLeader = myRole === 'leader';

      const listH = this.members.length * ROW_H;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, listH - maxH)));

      let cy = y0 - this[scrollKey];
      for (const mem of this.members) {
        if (cy + ROW_H < y0 || cy > y0 + maxH) { cy += ROW_H; continue; }
        const bar = new PIXI.Graphics();
        sketchAccentBar(bar, ROW_H - 4, mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : C.mid);
        bar.x = x0 + 6; bar.y = cy + 2;
        this.bodyLayer.addChild(bar);

        const roleLbl = txt(t(`family.${mem.role as 'leader' | 'member' | 'elder'}`), 10, C.mid);
        roleLbl.x = x0 + 16; roleLbl.y = cy + 4;
        this.bodyLayer.addChild(roleLbl);
        const nameLbl = txt(mem.displayName ?? mem.publicId ?? '', 13, C.dark);
        nameLbl.x = x0 + 16; nameLbl.y = cy + 18;
        this.bodyLayer.addChild(nameLbl);

        // Action buttons for leader (promote/demote elders + kick).
        if (isLeader && mem.accountId !== me) {
          const accId = mem.accountId;

          // Role toggle: members → elder, elders → member. (Leader role only changes via transfer/dissolve.)
          if (mem.role !== 'leader') {
            const toElder = mem.role === 'member';
            const roleBtn = sketchPanel(50, 22, { fill: 0xeef0e0, border: 0xd4a030, seed: seedFor(cy, 2, 50) });
            roleBtn.x = right - 116; roleBtn.y = cy + 10;
            this.bodyLayer.addChild(roleBtn);
            const rl = txt(t(toElder ? 'family.setElder' : 'family.setMember'), 10, 0xb8881a);
            rl.anchor.set(0.5, 0.5); rl.x = right - 91; rl.y = cy + 21;
            this.bodyLayer.addChild(rl);
            const nextRole: 'elder' | 'member' = toElder ? 'elder' : 'member';
            this.hitRects.push({ rect: { x: right - 116, y: cy + 10, w: 50, h: 22 }, action: () => void this.doSetRole(accId, nextRole) });
          }

          const kickBtn = sketchPanel(50, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 0, 50) });
          kickBtn.x = right - 60; kickBtn.y = cy + 10;
          this.bodyLayer.addChild(kickBtn);
          const kl = txt(t('family.kick'), 11, C.red);
          kl.anchor.set(0.5, 0.5); kl.x = right - 35; kl.y = cy + 21;
          this.bodyLayer.addChild(kl);
          this.hitRects.push({ rect: { x: right - 60, y: cy + 10, w: 50, h: 22 }, action: () => this.confirmKick(accId, mem.displayName ?? mem.publicId ?? '') });
        }

        cy += ROW_H;
      }

      // Vacancy hint: turns the leftover space below a small roster into information ("room to
      // grow") instead of dead whitespace, without implying an invite feature that doesn't exist yet.
      const vacancies = FAMILY_CAP - this.members.length;
      if (vacancies > 0 && cy + 20 < y0 + maxH) {
        const vacLbl = txt(t('family.vacancies', { n: vacancies }), 12, C.mid);
        vacLbl.alpha = 0.6;
        vacLbl.x = x0 + 16; vacLbl.y = cy + 10;
        this.bodyLayer.addChild(vacLbl);
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: maxH }, this[scrollKey], Math.max(0, listH - maxH));
    }

    /** Sect hub entry (left) + Leave / Dissolve (right) — shared by both the tabbed (portrait)
     *  and split (landscape) layouts, drawn once beneath whichever content is above it. */
    private renderBottomBar(left: number, w: number, barY: number): void {
      const me = this.cb.myAccountId;
      const myRole = this.members.find(m => m.accountId === me)?.role ?? 'member';
      const isLdr = myRole === 'leader';
      const midX = (left + w) / 2;

      const sectBtn = sketchPanel(110, 32, { fill: C.dark, border: C.accent, seed: seedFor(2, 0, 110) });
      sectBtn.x = midX - 120; sectBtn.y = barY;
      this.bodyLayer.addChild(sectBtn);
      const sbl = txt(t('family.sect'), 13, C.light);
      sbl.anchor.set(0.5, 0.5); sbl.x = midX - 65; sbl.y = barY + 16;
      this.bodyLayer.addChild(sbl);
      this.hitRects.push({ rect: { x: midX - 120, y: barY, w: 110, h: 32 }, action: () => this.cb.onOpenSect() });

      const btnLabel = isLdr ? t('family.dissolve') : t('family.leave');
      const btnColor = isLdr ? C.red : C.accent;
      const btn = sketchPanel(110, 32, { fill: 0xf8f8f0, border: btnColor, seed: seedFor(0, 0, 110) });
      btn.x = midX + 10; btn.y = barY;
      this.bodyLayer.addChild(btn);
      const bl = txt(btnLabel, 13, btnColor);
      bl.anchor.set(0.5, 0.5); bl.x = midX + 65; bl.y = barY + 16;
      this.bodyLayer.addChild(bl);
      this.hitRects.push({
        rect: { x: midX + 10, y: barY, w: 110, h: 32 },
        action: () => isLdr ? this.confirmDissolve() : this.confirmLeave(),
      });
    }

    /** Channel column. Same `x0`/`colW`/`scrollKey` parametrization as `renderMembers` — see there. */
    private renderChannel(x0: number, colW: number, y0: number, maxH: number, scrollKey: 'scrollY' | 'scrollYChannel'): void {
      const right = x0 + colW;
      const inputH = 44;
      const listH2 = maxH - inputH - 6;

      // Message list
      const msgH = this.messages.length * ROW_H;
      this[scrollKey] = Math.max(0, Math.min(this[scrollKey], Math.max(0, msgH - listH2)));

      let cy = y0 - this[scrollKey];
      for (const msg of this.messages) {
        if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
        const nameLbl = txt(msg.senderName ?? msg.senderId, 11, C.accent);
        nameLbl.x = x0 + 12; nameLbl.y = cy + 4;
        this.bodyLayer.addChild(nameLbl);
        const bodyLbl = txt(msg.body, 12, C.dark);
        bodyLbl.x = x0 + 12; bodyLbl.y = cy + 18;
        this.bodyLayer.addChild(bodyLbl);
        cy += ROW_H;
      }

      drawScrollIndicator(this.bodyLayer, { x: x0, y: y0, w: colW, h: listH2 }, this[scrollKey], Math.max(0, msgH - listH2));

      if (this.messages.length === 0) {
        const emptyLbl = txt(t('family.noMessages'), 12, C.mid);
        emptyLbl.alpha = 0.6;
        emptyLbl.x = x0 + 12; emptyLbl.y = y0 + 8;
        this.bodyLayer.addChild(emptyLbl);
      }

      // Input area
      const inputY = y0 + listH2 + 4;
      const fieldW = right - x0 - 80;
      const field = sketchPanel(fieldW, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, fieldW) });
      field.x = x0 + 6; field.y = inputY;
      this.bodyLayer.addChild(field);
      const fl = txt(t('family.msgPlaceholder'), 12, C.mid);
      fl.x = x0 + 12; fl.y = inputY + 10;
      this.bodyLayer.addChild(fl);
      this.hitRects.push({ rect: { x: x0 + 6, y: inputY, w: fieldW, h: 36 }, action: () => this.openSendInput() });

      const sendBtn = sketchPanel(66, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 66) });
      sendBtn.x = right - 72; sendBtn.y = inputY;
      this.bodyLayer.addChild(sendBtn);
      const sl = txt(t('family.send'), 13, C.light);
      sl.anchor.set(0.5, 0.5); sl.x = right - 39; sl.y = inputY + 18;
      this.bodyLayer.addChild(sl);
      this.hitRects.push({ rect: { x: right - 72, y: inputY, w: 66, h: 36 }, action: () => void this.doSendMsg() });
    }
  };
}
