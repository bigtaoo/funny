// FamilyScene — SLG 家族管理场景（S8-4）
// 状态机：noFamily → search/create 分支；myFamily → channel/members

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor } from '../render/sketchUi';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import type { WorldApiClient, FamilyView, FamilyMemberView, FamilyMessageView } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';

export interface FamilySceneCallbacks {
  onBack(): void;
  /** Open the sect hub (S8-4b) — sect = a family-of-families, rooted in the family UI. */
  onOpenSect(): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
}

type FamilyTab = 'members' | 'channel';
type ViewMode = 'loading' | 'noFamily' | 'create' | 'myFamily';

const ROW_H = 48;
const HUD_H = 50;

export class FamilyScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: FamilySceneCallbacks;

  private mode: ViewMode = 'loading';
  private activeTab: FamilyTab = 'members';

  private family: FamilyView | null = null;
  private members: FamilyMemberView[] = [];
  private messages: FamilyMessageView[] = [];

  private bodyLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;

  // Input overlay for create form
  private hiddenInput: HTMLInputElement | null = null;
  private createName = '';
  private createTag = '';
  private createField: 'name' | 'tag' | null = null;

  // Scroll
  private scrollY = 0;
  private dragStart: { x: number; y: number; scroll: number } | null = null;
  private dragMoved = false;

  // Hit rects
  private hitRects: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalHits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private modalOpen = false;

  // Toast
  private toastTimer = 0;
  private destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: FamilySceneCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();
    this.build();
    void this.loadData();

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
  }

  private build(): void {
    const { w, h } = this;
    const bg = buildPaperBackground('family', w, h);
    this.container.addChild(bg);

    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.modalLayer = new PIXI.Container();
    this.container.addChild(this.modalLayer);

    this.toastLayer = new PIXI.Container();
    this.container.addChild(this.toastLayer);

    this.renderHeader();
  }

  private renderHeader(): void {
    const { w } = this;
    const hdr = drawSceneHeader(this.container, w, this.h, t('family.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 15,
    });
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
    if (this.destroyed) return;
    try {
      // Try to get my family by fetching the family list and seeing which one I'm in
      // The server's getMe includes familyId
      // We call listFamilies then look for one where the player is a member
      const me = await this.cb.worldApi.getMe(this.cb.worldId);
      if (me.familyId) {
        await this.loadMyFamily(me.familyId);
      } else {
        this.mode = 'noFamily';
      }
    } catch {
      this.mode = 'noFamily';
    }
    if (!this.destroyed) this.render();
  }

  private async loadMyFamily(familyId: string): Promise<void> {
    const fam = await this.cb.worldApi.getFamily(familyId);
    this.family = fam;
    this.members = fam.members ?? [];
    this.mode = 'myFamily';
    await this.loadChannel();
  }

  private async loadChannel(): Promise<void> {
    if (!this.family) return;
    const ch = await this.cb.worldApi.getFamilyChannel(this.cb.worldId, this.family.familyId);
    this.messages = ch;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  private render(): void {
    if (this.destroyed) return;
    this.bodyLayer.removeChildren();
    this.hitRects = [];
    this.renderHeader();

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noFamily': this.renderNoFamily(); break;
      case 'create': this.renderCreate(); break;
      case 'myFamily': this.renderMyFamily(); break;
    }
  }

  private renderLoading(): void {
    const lbl = txt(t('world.loading'), 14, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = this.w / 2; lbl.y = this.h / 2;
    this.bodyLayer.addChild(lbl);
  }

  private renderNoFamily(): void {
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

  private renderCreate(): void {
    const { w, h } = this;

    const lbl1 = txt(t('family.name') + ':', 13, C.dark);
    lbl1.x = 20; lbl1.y = HUD_H + 20;
    this.bodyLayer.addChild(lbl1);

    const nameField = sketchPanel(w - 120, 32, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - 120) });
    nameField.x = 100; nameField.y = HUD_H + 14;
    this.bodyLayer.addChild(nameField);
    const nl = txt(this.createName || ' ', 13, C.dark);
    nl.x = 108; nl.y = HUD_H + 22;
    this.bodyLayer.addChild(nl);
    this.hitRects.push({ rect: { x: 100, y: HUD_H + 14, w: w - 120, h: 32 }, action: () => this.openInputFor('name') });

    const lbl2 = txt(t('family.tag') + ':', 13, C.dark);
    lbl2.x = 20; lbl2.y = HUD_H + 70;
    this.bodyLayer.addChild(lbl2);

    const tagField = sketchPanel(100, 32, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, 100) });
    tagField.x = 100; tagField.y = HUD_H + 64;
    this.bodyLayer.addChild(tagField);
    const tl = txt(this.createTag || ' ', 13, C.dark);
    tl.x = 108; tl.y = HUD_H + 72;
    this.bodyLayer.addChild(tl);
    this.hitRects.push({ rect: { x: 100, y: HUD_H + 64, w: 100, h: 32 }, action: () => this.openInputFor('tag') });

    const hint = txt('[A-Z0-9] 2-5 chars', 11, C.mid);
    hint.x = 210; hint.y = HUD_H + 72;
    this.bodyLayer.addChild(hint);

    const okBtn = sketchPanel(100, 34, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 100) });
    okBtn.x = w / 2 - 110; okBtn.y = HUD_H + 120;
    this.bodyLayer.addChild(okBtn);
    const ok = txt(t('family.create'), 13, C.light);
    ok.anchor.set(0.5, 0.5); ok.x = w / 2 - 60; ok.y = HUD_H + 137;
    this.bodyLayer.addChild(ok);
    this.hitRects.push({ rect: { x: w / 2 - 110, y: HUD_H + 120, w: 100, h: 34 }, action: () => void this.doCreate() });

    const cancelBtn = sketchPanel(100, 34, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, 100) });
    cancelBtn.x = w / 2 + 10; cancelBtn.y = HUD_H + 120;
    this.bodyLayer.addChild(cancelBtn);
    const ca = txt('✕', 13, C.dark);
    ca.anchor.set(0.5, 0.5); ca.x = w / 2 + 60; ca.y = HUD_H + 137;
    this.bodyLayer.addChild(ca);
    this.hitRects.push({ rect: { x: w / 2 + 10, y: HUD_H + 120, w: 100, h: 34 }, action: () => { this.mode = 'noFamily'; this.render(); } });
  }

  private renderMyFamily(): void {
    if (!this.family) return;
    const { w, h } = this;

    // Tab bar
    const tabs: FamilyTab[] = ['members', 'channel'];
    const tabW = w / tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]!;
      const active = tab === this.activeTab;
      const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
      tp.x = i * tabW; tp.y = HUD_H;
      this.bodyLayer.addChild(tp);
      const tl = txt(t(tab === 'members' ? 'family.tabMembers' : 'family.channel'), 13, active ? C.accent : C.dark);
      tl.anchor.set(0.5, 0.5); tl.x = i * tabW + tabW / 2; tl.y = HUD_H + 18;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: i * tabW, y: HUD_H, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
    }

    const contentY = HUD_H + 36;
    const contentH = h - contentY - 10;

    if (this.activeTab === 'members') {
      this.renderMembers(contentY, contentH);
    } else {
      this.renderChannel(contentY, contentH);
    }
  }

  private renderMembers(y0: number, maxH: number): void {
    const { w } = this;
    const me = this.cb.myAccountId;

    const myRole = this.members.find(m => m.accountId === me)?.role ?? 'member';
    const isLeader = myRole === 'leader';

    const listH = this.members.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, listH - maxH)));

    let cy = y0 - this.scrollY;
    for (const mem of this.members) {
      if (cy + ROW_H < y0 || cy > y0 + maxH) { cy += ROW_H; continue; }
      const bar = new PIXI.Graphics();
      sketchAccentBar(bar, ROW_H - 4, mem.role === 'leader' ? C.accent : mem.role === 'elder' ? 0xd4a030 : C.mid);
      bar.x = 6; bar.y = cy + 2;
      this.bodyLayer.addChild(bar);

      const roleLbl = txt(t(`family.${mem.role as 'leader' | 'member' | 'elder'}`), 10, C.mid);
      roleLbl.x = 16; roleLbl.y = cy + 4;
      this.bodyLayer.addChild(roleLbl);
      const nameLbl = txt(mem.displayName ?? mem.publicId ?? '', 13, C.dark);
      nameLbl.x = 16; nameLbl.y = cy + 18;
      this.bodyLayer.addChild(nameLbl);

      // Action buttons for leader (promote/demote elders + kick).
      if (isLeader && mem.accountId !== me) {
        const accId = mem.accountId;

        // Role toggle: members → elder, elders → member. (Leader role only changes via transfer/dissolve.)
        if (mem.role !== 'leader') {
          const toElder = mem.role === 'member';
          const roleBtn = sketchPanel(50, 22, { fill: 0xeef0e0, border: 0xd4a030, seed: seedFor(cy, 2, 50) });
          roleBtn.x = w - 116; roleBtn.y = cy + 10;
          this.bodyLayer.addChild(roleBtn);
          const rl = txt(t(toElder ? 'family.setElder' : 'family.setMember'), 10, 0xb8881a);
          rl.anchor.set(0.5, 0.5); rl.x = w - 91; rl.y = cy + 21;
          this.bodyLayer.addChild(rl);
          const nextRole: 'elder' | 'member' = toElder ? 'elder' : 'member';
          this.hitRects.push({ rect: { x: w - 116, y: cy + 10, w: 50, h: 22 }, action: () => void this.doSetRole(accId, nextRole) });
        }

        const kickBtn = sketchPanel(50, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 0, 50) });
        kickBtn.x = w - 60; kickBtn.y = cy + 10;
        this.bodyLayer.addChild(kickBtn);
        const kl = txt(t('family.kick'), 11, C.red);
        kl.anchor.set(0.5, 0.5); kl.x = w - 35; kl.y = cy + 21;
        this.bodyLayer.addChild(kl);
        this.hitRects.push({ rect: { x: w - 60, y: cy + 10, w: 50, h: 22 }, action: () => this.confirmKick(accId, mem.displayName ?? mem.publicId ?? '') });
      }

      cy += ROW_H;
    }

    // Bottom bar: Sect hub entry (left) + Leave / Dissolve (right).
    const isLdr = myRole === 'leader';
    const barY = y0 + maxH - 36;

    const sectBtn = sketchPanel(110, 32, { fill: C.dark, border: C.accent, seed: seedFor(2, 0, 110) });
    sectBtn.x = w / 2 - 120; sectBtn.y = barY;
    this.bodyLayer.addChild(sectBtn);
    const sbl = txt(t('family.sect'), 13, C.light);
    sbl.anchor.set(0.5, 0.5); sbl.x = w / 2 - 65; sbl.y = barY + 16;
    this.bodyLayer.addChild(sbl);
    this.hitRects.push({ rect: { x: w / 2 - 120, y: barY, w: 110, h: 32 }, action: () => this.cb.onOpenSect() });

    const btnLabel = isLdr ? t('family.dissolve') : t('family.leave');
    const btnColor = isLdr ? C.red : C.accent;
    const btn = sketchPanel(110, 32, { fill: 0xf8f8f0, border: btnColor, seed: seedFor(0, 0, 110) });
    btn.x = w / 2 + 10; btn.y = barY;
    this.bodyLayer.addChild(btn);
    const bl = txt(btnLabel, 13, btnColor);
    bl.anchor.set(0.5, 0.5); bl.x = w / 2 + 65; bl.y = barY + 16;
    this.bodyLayer.addChild(bl);
    this.hitRects.push({
      rect: { x: w / 2 + 10, y: barY, w: 110, h: 32 },
      action: () => isLdr ? this.confirmDissolve() : this.confirmLeave(),
    });
  }

  private renderChannel(y0: number, maxH: number): void {
    const { w } = this;
    const inputH = 44;
    const listH2 = maxH - inputH - 6;

    // Message list
    const msgH = this.messages.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, msgH - listH2)));

    let cy = y0 - this.scrollY;
    for (const msg of this.messages) {
      if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
      const nameLbl = txt(msg.fromName ?? msg.from, 11, C.accent);
      nameLbl.x = 12; nameLbl.y = cy + 4;
      this.bodyLayer.addChild(nameLbl);
      const bodyLbl = txt(msg.body, 12, C.dark);
      bodyLbl.x = 12; bodyLbl.y = cy + 18;
      this.bodyLayer.addChild(bodyLbl);
      cy += ROW_H;
    }

    // Input area
    const inputY = y0 + listH2 + 4;
    const field = sketchPanel(w - 80, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, w - 80) });
    field.x = 6; field.y = inputY;
    this.bodyLayer.addChild(field);
    const fl = txt(t('family.msgPlaceholder'), 12, C.mid);
    fl.x = 12; fl.y = inputY + 10;
    this.bodyLayer.addChild(fl);
    this.hitRects.push({ rect: { x: 6, y: inputY, w: w - 80, h: 36 }, action: () => this.openSendInput() });

    const sendBtn = sketchPanel(66, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 66) });
    sendBtn.x = w - 72; sendBtn.y = inputY;
    this.bodyLayer.addChild(sendBtn);
    const sl = txt(t('family.send'), 13, C.light);
    sl.anchor.set(0.5, 0.5); sl.x = w - 39; sl.y = inputY + 18;
    this.bodyLayer.addChild(sl);
    this.hitRects.push({ rect: { x: w - 72, y: inputY, w: 66, h: 36 }, action: () => void this.doSendMsg() });
  }

  // ── Input overlay ──────────────────────────────────────────────────────────

  private openInputFor(field: 'name' | 'tag'): void {
    this.createField = field;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = field === 'name' ? this.createName : this.createTag;
    inp.maxLength = field === 'name' ? 24 : 5;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('input', () => {
      if (field === 'name') this.createName = inp.value;
      else this.createTag = inp.value.toUpperCase();
      if (!this.destroyed) this.render();
    });
    inp.addEventListener('blur', () => {
      this.createField = null;
      document.body.removeChild(inp);
      if (!this.destroyed) this.render();
    });
    this.hiddenInput = inp;
  }

  private openSendInput(): void {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 200;
    inp.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
    document.body.appendChild(inp);
    inp.focus();
    inp.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') {
        const body = inp.value.trim();
        inp.remove();
        if (body && this.family) {
          try {
            await this.cb.worldApi.sendFamilyMessage(this.cb.worldId, body);
            await this.loadChannel();
            if (!this.destroyed) this.render();
          } catch (err) {
            this.showToast(this.errorMsg(err), C.red);
          }
        }
      }
    });
    inp.addEventListener('blur', () => { inp.remove(); });
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  private async doCreate(): Promise<void> {
    if (!this.createName.trim() || !this.createTag.trim()) {
      this.showToast(t('family.err.badTag'), C.red); return;
    }
    try {
      this.family = await this.cb.worldApi.createFamily(this.cb.worldId, this.createName.trim(), this.createTag.trim());
      this.members = this.family.members ?? [];
      this.messages = [];
      this.mode = 'myFamily';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async openJoinList(): Promise<void> {
    try {
      const list = await this.cb.worldApi.listFamilies(this.cb.worldId);
      this.showPickModal(list);
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private showPickModal(families: FamilyView[]): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(300, w - 32);
    const mh = Math.min(300, h - 80);
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeModal() });

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    if (families.length === 0) {
      const lbl = txt(t('family.noFamily'), 13, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    let cy = my + 10;
    for (const fam of families.slice(0, 6)) {
      const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
      row.x = mx + 8; row.y = cy;
      ml.addChild(row);
      const lbl = txt(`[${fam.tag}] ${fam.name} (${fam.memberCount})`, 12, C.dark);
      lbl.x = mx + 14; lbl.y = cy + 10;
      ml.addChild(lbl);
      const famId = fam.familyId;
      this.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => void this.doJoin(famId) });
      cy += 40;
    }
  }

  private async doJoin(familyId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.joinFamily(this.cb.worldId, familyId);
      await this.loadMyFamily(familyId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmLeave(): void {
    this.showConfirm(t('family.confirmLeave'), () => void this.doLeave());
  }

  private async doLeave(): Promise<void> {
    this.closeModal();
    if (!this.family) return;
    try {
      await this.cb.worldApi.leaveFamily(this.cb.worldId);
      this.family = null; this.members = []; this.messages = [];
      this.mode = 'noFamily';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmDissolve(): void {
    this.showConfirm(t('family.confirmDissolve'), () => void this.doDissolve());
  }

  private async doDissolve(): Promise<void> {
    this.closeModal();
    if (!this.family) return;
    try {
      await this.cb.worldApi.dissolveFamily(this.cb.worldId);
      this.family = null; this.members = []; this.messages = [];
      this.mode = 'noFamily';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmKick(targetId: string, name: string): void {
    this.showConfirm(t('family.confirmKick'), () => void this.doKick(targetId));
  }

  private async doKick(targetId: string): Promise<void> {
    this.closeModal();
    if (!this.family) return;
    try {
      await this.cb.worldApi.kickMember(this.cb.worldId, targetId);
      this.members = this.members.filter(m => m.accountId !== targetId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doSetRole(targetId: string, role: 'elder' | 'member'): Promise<void> {
    if (!this.family) return;
    try {
      await this.cb.worldApi.setRole(this.cb.worldId, targetId, role);
      const m = this.members.find(mem => mem.accountId === targetId);
      if (m) m.role = role;
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doSendMsg(): Promise<void> {
    // Handled inline by openSendInput
  }

  // ── Confirm modal ─────────────────────────────────────────────────────────

  private showConfirm(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(280, w - 40);
    const mh = 110;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const lbl = txt(msg, 13, C.dark);
    lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + 14;
    ml.addChild(lbl);

    const okBtn = sketchPanel(80, 28, { fill: C.dark, border: C.accent, seed: seedFor(0, 1, 80) });
    okBtn.x = mx + mw / 2 - 88; okBtn.y = my + mh - 36;
    ml.addChild(okBtn);
    const ol = txt('OK', 13, C.light);
    ol.anchor.set(0.5, 0.5); ol.x = mx + mw / 2 - 48; ol.y = my + mh - 22;
    ml.addChild(ol);
    this.modalHits.push({ rect: { x: okBtn.x, y: okBtn.y, w: 80, h: 28 }, action: onOk });

    const cancelBtn = sketchPanel(80, 28, { fill: 0xeeeeee, border: C.mid, seed: seedFor(0, 2, 80) });
    cancelBtn.x = mx + mw / 2 + 8; cancelBtn.y = my + mh - 36;
    ml.addChild(cancelBtn);
    const cl = txt('✕', 13, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = mx + mw / 2 + 48; cl.y = my + mh - 22;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    const tl = this.toastLayer;
    tl.removeChildren();
    const lbl = txt(msg, 13, color);
    lbl.anchor.set(0.5, 0);
    lbl.x = this.w / 2; lbl.y = this.h - 80;
    tl.addChild(lbl);
    this.toastTimer = 2500;
  }

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      const map: Record<string, string> = {
        ALREADY_IN_FAMILY: t('family.err.alreadyIn'),
        FAMILY_FULL:       t('family.err.cap'),
        NOT_IN_FAMILY:     t('family.err.notIn'),
        NO_PERMISSION:     t('family.err.noPermission'),
        INVALID_TAG:       t('family.err.badTag'),
        NOT_FOUND:         t('family.err.notFound'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  handleDown(x: number, y: number): void {
    if (this.modalOpen) {
      for (const { rect, action } of this.modalHits) {
        if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
          action(); return;
        }
      }
      return;
    }
    for (const { rect, action } of this.hitRects) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action(); return;
      }
    }
    this.dragStart = { x, y, scroll: this.scrollY };
    this.dragMoved = false;
  }

  handleMove(x: number, y: number): void {
    if (!this.dragStart) return;
    const dy = y - this.dragStart.y;
    if (Math.abs(dy) > 6) {
      this.dragMoved = true;
      this.scrollY = Math.max(0, this.dragStart.scroll - dy);
      this.render();
    }
  }

  handleUp(_x: number, _y: number): void {
    this.dragStart = null;
  }

  update(dt: number): void {
    if (this.toastTimer > 0) {
      this.toastTimer -= dt * 1000;
      if (this.toastTimer <= 0) this.toastLayer.removeChildren();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    if (this.hiddenInput) { this.hiddenInput.remove(); this.hiddenInput = null; }
    this.container.destroy({ children: true });
  }
}
