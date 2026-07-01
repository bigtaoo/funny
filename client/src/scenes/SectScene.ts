// SectScene â€” SLG sect management scene (S8-4b, C6).
// A sect = a faction organization composed of families within a region; member unit is a family, linked by family.sectId.
// Most write operations require the requester to be the family leader (representing the whole family); disband/ally/unally are sect-master only.
// Channel is readable/writable by any sect member. Real-time push at scale goes through Redis (this slice uses REST polling, see SLG_DESIGN Â§9.3).
//
// Entry point: FamilyScene's "Sect" button (sects are the family of families, naturally belongs in the family UI).
// Aligned with FamilyScene pattern: modalLayer + hitRects/modalHits (dim click to close), hand-drawn sketchPanel/txt,
// subscribe input.onDown/Move/Up in constructor + unsubscribe in destroy (SLG scene input subscription was a latent bug, fixed in C3).

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, sketchAccentBar, seedFor, tearDownChildren } from '../render/sketchUi';
import { buildDecorCLayer } from '../render/decorCLayer';
import { drawSceneHeader } from '../ui/widgets/SceneHeader';
import type {
  WorldApiClient, SectView, SectDetailView, SectMemberFamilyView, SectMessageView,
} from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';

export interface SectSceneCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  /** current player's accountId */
  myAccountId: string;
  /** display name used as senderName for channel messages */
  playerName: string;
}

/** Handle returned by showSect so the core can push live sect-channel messages in. */
export interface SectSceneView {
  applySectMsg(msg: SectMessageView): void;
}

type SectTab = 'families' | 'channel';
type ViewMode = 'loading' | 'noSect' | 'create' | 'mySect';

const ROW_H = 48;
const HUD_H = 50;

export class SectScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: SectSceneCallbacks;

  private mode: ViewMode = 'loading';
  private activeTab: SectTab = 'families';

  // My family context (drives permission gating).
  private myFamilyId: string | null = null;
  private myFamilyRole: 'leader' | 'elder' | 'member' | null = null;
  private inFamily = false;

  private sect: SectDetailView | null = null;
  private messages: SectMessageView[] = [];
  /** cache of all sects in the world â€” used for browse/ally name resolution. */
  private sectsCache: SectView[] = [];

  private bodyLayer!: PIXI.Container;
  private toastLayer!: PIXI.Container;
  private modalLayer!: PIXI.Container;

  // Create form
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

  private toastTimer = 0;
  private destroyed = false;
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: SectSceneCallbacks) {
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
    const bg = buildPaperBackground('sect', w, h);
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(w, h);
    if (decoC) this.container.addChild(decoC);

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
    const hdr = drawSceneHeader(this.container, w, this.h, t('sect.title'), {
      variant: 'paper', headerH: HUD_H, titleSize: 15,
    });
    this.hitRects.push({ rect: hdr.backRect, action: () => this.cb.onBack() });
  }

  // â”€â”€ Permission helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private get isFamilyLeader(): boolean { return this.myFamilyRole === 'leader'; }
  private get isSectLeader(): boolean { return !!this.sect && this.sect.leaderId === this.cb.myAccountId; }

  // â”€â”€ Data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private async loadData(): Promise<void> {
    if (this.destroyed) return;
    try {
      const me = await this.cb.worldApi.getMe(this.cb.worldId);
      if (!me.familyId) {
        this.inFamily = false;
        this.mode = 'noSect';
      } else {
        this.inFamily = true;
        this.myFamilyId = me.familyId;
        const fam = await this.cb.worldApi.getFamily(me.familyId);
        this.myFamilyRole = fam.members?.find(m => m.accountId === this.cb.myAccountId)?.role ?? 'member';
        // TODO(sectId gap): socialsvc's FamilyDetailView carries no sectId — this branch never resolves a
        // sect since the P4 family migration (2026-06-29). See project_social_system memory / spawned task.
        this.mode = 'noSect';
      }
    } catch {
      this.mode = 'noSect';
    }
    if (!this.destroyed) this.render();
  }

  private async loadMySect(sectId: string): Promise<void> {
    const sect = await this.cb.worldApi.getSect(sectId);
    this.sect = sect;
    this.mode = 'mySect';
    await this.loadChannel();
  }

  private async loadChannel(): Promise<void> {
    if (!this.sect) return;
    this.messages = await this.cb.worldApi.getSectChannel(this.cb.worldId);
  }

  /**
   * Received a real-time sect channel message (gateway push, S8-4b) â†’ deduplicate, insert, and re-render if needed.
   * messages are newest-first (consistent with getSectChannel), so new messages are unshifted to the front.
   */
  applySectMsg(msg: SectMessageView): void {
    if (this.destroyed) return;
    if (this.messages.some((m) => m.ts === msg.ts && m.senderId === msg.senderId && m.body === msg.body)) {
      return; // deduplicate with polling / resend
    }
    this.messages.unshift(msg);
    if (this.mode === 'mySect' && this.activeTab === 'channel') this.render();
  }

  // â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private render(): void {
    if (this.destroyed) return;
    tearDownChildren(this.bodyLayer); // create-form input re-renders per keystroke â†’ free Text textures
    this.hitRects = [];
    this.renderHeader();

    switch (this.mode) {
      case 'loading': this.renderLoading(); break;
      case 'noSect': this.renderNoSect(); break;
      case 'create': this.renderCreate(); break;
      case 'mySect': this.renderMySect(); break;
    }
  }

  private renderLoading(): void {
    const lbl = txt(t('world.loading'), 14, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = this.w / 2; lbl.y = this.h / 2;
    this.bodyLayer.addChild(lbl);
  }

  private renderNoSect(): void {
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

    const lbl = txt(t('sect.noSect'), 14, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = w / 2; lbl.y = h / 2 - 50;
    this.bodyLayer.addChild(lbl);

    const hint = txt(t('sect.createHint'), 11, C.mid);
    hint.anchor.set(0.5, 0.5);
    hint.x = w / 2; hint.y = h / 2 - 28;
    this.bodyLayer.addChild(hint);

    this.addCenterButton(t('sect.create'), w / 2 - 130, h / 2, () => { this.mode = 'create'; this.render(); }, 0);
    this.addCenterButton(t('sect.browse'), w / 2 + 10, h / 2, () => void this.openBrowseList(), 1);
  }

  private renderCreate(): void {
    const { w } = this;

    const lbl1 = txt(t('sect.name') + ':', 13, C.dark);
    lbl1.x = 20; lbl1.y = HUD_H + 20;
    this.bodyLayer.addChild(lbl1);

    const nameField = sketchPanel(w - 120, 32, { fill: 0xfaf9f5, border: this.createField === 'name' ? C.accent : C.mid, seed: seedFor(0, 0, w - 120) });
    nameField.x = 100; nameField.y = HUD_H + 14;
    this.bodyLayer.addChild(nameField);
    const nl = txt(this.createName || ' ', 13, C.dark);
    nl.x = 108; nl.y = HUD_H + 22;
    this.bodyLayer.addChild(nl);
    this.hitRects.push({ rect: { x: 100, y: HUD_H + 14, w: w - 120, h: 32 }, action: () => this.openInputFor('name') });

    const lbl2 = txt(t('sect.tag') + ':', 13, C.dark);
    lbl2.x = 20; lbl2.y = HUD_H + 70;
    this.bodyLayer.addChild(lbl2);

    const tagField = sketchPanel(100, 32, { fill: 0xfaf9f5, border: this.createField === 'tag' ? C.accent : C.mid, seed: seedFor(1, 0, 100) });
    tagField.x = 100; tagField.y = HUD_H + 64;
    this.bodyLayer.addChild(tagField);
    const tl = txt(this.createTag || ' ', 13, C.dark);
    tl.x = 108; tl.y = HUD_H + 72;
    this.bodyLayer.addChild(tl);
    this.hitRects.push({ rect: { x: 100, y: HUD_H + 64, w: 100, h: 32 }, action: () => this.openInputFor('tag') });

    const okBtn = sketchPanel(100, 34, { fill: C.dark, border: C.accent, seed: seedFor(0, 0, 100) });
    okBtn.x = w / 2 - 110; okBtn.y = HUD_H + 120;
    this.bodyLayer.addChild(okBtn);
    const ok = txt(t('sect.create'), 13, C.light);
    ok.anchor.set(0.5, 0.5); ok.x = w / 2 - 60; ok.y = HUD_H + 137;
    this.bodyLayer.addChild(ok);
    this.hitRects.push({ rect: { x: w / 2 - 110, y: HUD_H + 120, w: 100, h: 34 }, action: () => void this.doCreate() });

    const cancelBtn = sketchPanel(100, 34, { fill: 0xeeeeee, border: C.mid, seed: seedFor(1, 0, 100) });
    cancelBtn.x = w / 2 + 10; cancelBtn.y = HUD_H + 120;
    this.bodyLayer.addChild(cancelBtn);
    const ca = txt('âœ•', 13, C.dark);
    ca.anchor.set(0.5, 0.5); ca.x = w / 2 + 60; ca.y = HUD_H + 137;
    this.bodyLayer.addChild(ca);
    this.hitRects.push({ rect: { x: w / 2 + 10, y: HUD_H + 120, w: 100, h: 34 }, action: () => { this.mode = 'noSect'; this.render(); } });
  }

  private renderMySect(): void {
    if (!this.sect) return;
    const { w, h } = this;

    // Tab bar
    const tabs: SectTab[] = ['families', 'channel'];
    const tabW = w / tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i]!;
      const active = tab === this.activeTab;
      const tp = sketchPanel(tabW, 36, { fill: active ? C.paper : 0xddddcc, border: C.mid, seed: seedFor(i, 0, tabW) });
      tp.x = i * tabW; tp.y = HUD_H;
      this.bodyLayer.addChild(tp);
      const tl = txt(t(tab === 'families' ? 'sect.tabFamilies' : 'sect.tabChannel'), 13, active ? C.accent : C.dark);
      tl.anchor.set(0.5, 0.5); tl.x = i * tabW + tabW / 2; tl.y = HUD_H + 18;
      this.bodyLayer.addChild(tl);
      this.hitRects.push({ rect: { x: i * tabW, y: HUD_H, w: tabW, h: 36 }, action: () => { this.activeTab = tab; this.scrollY = 0; this.render(); } });
    }

    const contentY = HUD_H + 36;
    const contentH = h - contentY - 10;

    if (this.activeTab === 'families') {
      this.renderFamilies(contentY, contentH);
    } else {
      this.renderChannel(contentY, contentH);
    }
  }

  private renderFamilies(y0: number, maxH: number): void {
    if (!this.sect) return;
    const { w } = this;
    const sect = this.sect;

    // Sect summary line (name [tag] Â· families Â· prosperity).
    const summary = txt(
      `[${sect.tag}] ${sect.name}   ${t('sect.families', { n: sect.memberFamilyCount })}   ${t('sect.prosperity', { n: sect.prosperity })}`,
      12, C.mid,
    );
    summary.x = 12; summary.y = y0;
    this.bodyLayer.addChild(summary);

    // Removal vote banner.
    let listTop = y0 + 22;
    if (sect.removalVote) {
      const nom = sect.memberFamilies.find(f => f.familyId === sect.removalVote!.nomineeFamilyId);
      const banner = txt(
        t('sect.voteStatus', {
          name: nom ? `[${nom.tag}] ${nom.name}` : sect.removalVote.nomineeFamilyId,
          cur: sect.removalVote.voteCount,
          need: sect.removalVote.needed,
        }),
        11, C.red,
      );
      banner.x = 12; banner.y = listTop;
      this.bodyLayer.addChild(banner);
      listTop += 20;
    }

    const bottomBarH = 42;
    const listH = sect.memberFamilies.length * ROW_H;
    const viewH = (y0 + maxH - bottomBarH) - listTop;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, listH - viewH)));

    let cy = listTop - this.scrollY;
    for (const fam of sect.memberFamilies) {
      if (cy + ROW_H >= listTop && cy <= listTop + viewH) {
        const isLeaderFam = fam.familyId === sect.leaderFamilyId;
        const bar = new PIXI.Graphics();
        sketchAccentBar(bar, ROW_H - 4, isLeaderFam ? C.accent : C.mid);
        bar.x = 6; bar.y = cy + 2;
        this.bodyLayer.addChild(bar);

        if (isLeaderFam) {
          const ldr = txt(t('sect.leaderFamily'), 10, C.accent);
          ldr.x = 16; ldr.y = cy + 4;
          this.bodyLayer.addChild(ldr);
        }
        const nameLbl = txt(`[${fam.tag}] ${fam.name}`, 13, C.dark);
        nameLbl.x = 16; nameLbl.y = cy + 18;
        this.bodyLayer.addChild(nameLbl);
        const statLbl = txt(`${t('family.members', { n: fam.memberCount })} Â· ${t('sect.territory', { n: fam.territoryCount })}`, 10, C.mid);
        statLbl.x = 16; statLbl.y = cy + 34;
        this.bodyLayer.addChild(statLbl);

        // Any family leader (except the current leader family) can launch / vote a removal.
        if (this.isFamilyLeader && !isLeaderFam) {
          const voteBtn = sketchPanel(56, 22, { fill: 0xf0e0e0, border: C.red, seed: seedFor(cy, 1, 56) });
          voteBtn.x = w - 66; voteBtn.y = cy + 12;
          this.bodyLayer.addChild(voteBtn);
          const vl = txt(t('sect.vote'), 10, C.red);
          vl.anchor.set(0.5, 0.5); vl.x = w - 38; vl.y = cy + 23;
          this.bodyLayer.addChild(vl);
          const nomId = fam.familyId;
          const nomLabel = `[${fam.tag}] ${fam.name}`;
          this.hitRects.push({ rect: { x: w - 66, y: cy + 12, w: 56, h: 22 }, action: () => this.confirmVote(nomId, nomLabel) });
        }
      }
      cy += ROW_H;
    }

    this.renderBottomBar(y0 + maxH - bottomBarH);
  }

  private renderBottomBar(y: number): void {
    const { w } = this;
    if (this.isSectLeader) {
      // Leader: dissolve / ally / manage allies.
      this.addBarButton(t('sect.dissolve'), 6, y, C.red, () => this.confirmDissolve(), 0);
      this.addBarButton(t('sect.ally'), w / 2 - 50, y, C.accent, () => void this.openAllyList(), 1);
      this.addBarButton(t('sect.manageAllies'), w - 106, y, C.dark, () => void this.openManageAllies(), 2);
    } else if (this.isFamilyLeader) {
      this.addBarButton(t('sect.leave'), w / 2 - 60, y, C.accent, () => this.confirmLeave(), 0);
    }
  }

  private renderChannel(y0: number, maxH: number): void {
    const { w } = this;
    const inputH = 44;
    const listH2 = maxH - inputH - 6;

    if (this.messages.length === 0) {
      const empty = txt(t('sect.noMessages'), 12, C.mid);
      empty.anchor.set(0.5, 0); empty.x = w / 2; empty.y = y0 + 8;
      this.bodyLayer.addChild(empty);
    }

    const msgH = this.messages.length * ROW_H;
    this.scrollY = Math.max(0, Math.min(this.scrollY, Math.max(0, msgH - listH2)));

    // Channel is returned newest-first; render oldest-at-top for natural reading.
    const ordered = [...this.messages].reverse();
    let cy = y0 - this.scrollY;
    for (const msg of ordered) {
      if (cy + ROW_H < y0 || cy > y0 + listH2) { cy += ROW_H; continue; }
      const nameLbl = txt(msg.senderName, 11, C.accent);
      nameLbl.x = 12; nameLbl.y = cy + 4;
      this.bodyLayer.addChild(nameLbl);
      const bodyLbl = txt(msg.body, 12, C.dark);
      bodyLbl.x = 12; bodyLbl.y = cy + 18;
      this.bodyLayer.addChild(bodyLbl);
      cy += ROW_H;
    }

    const inputY = y0 + listH2 + 4;
    const field = sketchPanel(w - 80, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(0, 0, w - 80) });
    field.x = 6; field.y = inputY;
    this.bodyLayer.addChild(field);
    const fl = txt(t('sect.msgPlaceholder'), 12, C.mid);
    fl.x = 12; fl.y = inputY + 10;
    this.bodyLayer.addChild(fl);
    this.hitRects.push({ rect: { x: 6, y: inputY, w: w - 80, h: 36 }, action: () => this.openSendInput() });

    const sendBtn = sketchPanel(66, 36, { fill: C.dark, border: C.accent, seed: seedFor(1, 0, 66) });
    sendBtn.x = w - 72; sendBtn.y = inputY;
    this.bodyLayer.addChild(sendBtn);
    const sl = txt(t('sect.send'), 13, C.light);
    sl.anchor.set(0.5, 0.5); sl.x = w - 39; sl.y = inputY + 18;
    this.bodyLayer.addChild(sl);
    this.hitRects.push({ rect: { x: w - 72, y: inputY, w: 66, h: 36 }, action: () => this.openSendInput() });
  }

  // â”€â”€ Small render helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private centerMessage(msg: string): void {
    const lbl = txt(msg, 14, C.dark);
    lbl.anchor.set(0.5, 0.5);
    lbl.x = this.w / 2; lbl.y = this.h / 2;
    this.bodyLayer.addChild(lbl);
  }

  private addCenterButton(label: string, x: number, y: number, action: () => void, seed: number): void {
    const btn = sketchPanel(120, 36, { fill: C.dark, border: C.accent, seed: seedFor(seed, 0, 120) });
    btn.x = x; btn.y = y;
    this.bodyLayer.addChild(btn);
    const lbl = txt(label, 13, C.light);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + 60; lbl.y = y + 18;
    this.bodyLayer.addChild(lbl);
    this.hitRects.push({ rect: { x, y, w: 120, h: 36 }, action });
  }

  private addBarButton(label: string, x: number, y: number, color: number, action: () => void, seed: number): void {
    const bw = 100;
    const btn = sketchPanel(bw, 32, { fill: 0xf8f8f0, border: color, seed: seedFor(seed, 2, bw) });
    btn.x = x; btn.y = y;
    this.bodyLayer.addChild(btn);
    const lbl = txt(label, 12, color);
    lbl.anchor.set(0.5, 0.5); lbl.x = x + bw / 2; lbl.y = y + 16;
    this.bodyLayer.addChild(lbl);
    this.hitRects.push({ rect: { x, y, w: bw, h: 32 }, action });
  }

  // â”€â”€ Input overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private openInputFor(field: 'name' | 'tag'): void {
    this.createField = field;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = field === 'name' ? this.createName : this.createTag;
    inp.maxLength = field === 'name' ? 20 : 5;
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
        if (body && this.sect) {
          try {
            await this.cb.worldApi.sendSectMessage(this.cb.worldId, body, this.cb.playerName);
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

  // â”€â”€ Actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private async doCreate(): Promise<void> {
    if (!this.createName.trim() || !this.createTag.trim()) {
      this.showToast(t('sect.err.badReq'), C.red); return;
    }
    try {
      this.sect = await this.cb.worldApi.createSect(this.cb.worldId, this.createName.trim(), this.createTag.trim());
      this.messages = [];
      this.mode = 'mySect';
      this.activeTab = 'families';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async openBrowseList(): Promise<void> {
    try {
      this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
      this.showSectPickModal(this.sectsCache, (sid) => void this.doJoin(sid), 'sect.noSects');
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async doJoin(sectId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.joinSect(this.cb.worldId, sectId);
      await this.loadMySect(sectId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmLeave(): void {
    this.showConfirm(t('sect.confirmLeave'), () => void this.doLeave());
  }

  private async doLeave(): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.leaveSect(this.cb.worldId);
      this.sect = null; this.messages = [];
      this.mode = 'noSect';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmDissolve(): void {
    this.showConfirm(t('sect.confirmDissolve'), () => void this.doDissolve());
  }

  private async doDissolve(): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.dissolveSect(this.cb.worldId);
      this.sect = null; this.messages = [];
      this.mode = 'noSect';
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmVote(nomineeFamilyId: string, nomineeLabel: string): void {
    this.showConfirm(t('sect.confirmVote', { name: nomineeLabel }), () => void this.doVote(nomineeFamilyId));
  }

  private async doVote(nomineeFamilyId: string): Promise<void> {
    this.closeModal();
    try {
      const res = await this.cb.worldApi.voteRemoveSectLeader(this.cb.worldId, nomineeFamilyId);
      this.showToast(
        res.passed ? t('sect.votePassed') : t('sect.voteCounted', { cur: res.voteCount, need: res.needed }),
        res.passed ? C.accent : C.dark,
      );
      if (this.sect) await this.loadMySect(this.sect.sectId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async openAllyList(): Promise<void> {
    if (!this.sect) return;
    const sect = this.sect;
    try {
      this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
      const candidates = this.sectsCache.filter(
        s => s.sectId !== sect.sectId && !sect.allySectIds.includes(s.sectId),
      );
      this.showSectPickModal(candidates, (sid) => {
        const target = candidates.find(s => s.sectId === sid);
        this.confirmAlly(sid, target ? `[${target.tag}] ${target.name}` : sid);
      }, 'sect.noSects');
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmAlly(targetSectId: string, label: string): void {
    this.showConfirm(t('sect.confirmAlly', { name: label }), () => void this.doAlly(targetSectId));
  }

  private async doAlly(targetSectId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.allySect(this.cb.worldId, targetSectId);
      if (this.sect) await this.loadMySect(this.sect.sectId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private async openManageAllies(): Promise<void> {
    if (!this.sect) return;
    const sect = this.sect;
    try {
      // Resolve ally ids â†’ names via the world sect list.
      this.sectsCache = await this.cb.worldApi.listSects(this.cb.worldId);
      const allies = sect.allySectIds
        .map(id => this.sectsCache.find(s => s.sectId === id))
        .filter((s): s is SectView => !!s);
      this.showSectPickModal(allies, (sid) => {
        const target = allies.find(s => s.sectId === sid);
        this.confirmUnally(sid, target ? `[${target.tag}] ${target.name}` : sid);
      }, 'sect.noAllies');
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  private confirmUnally(targetSectId: string, label: string): void {
    this.showConfirm(t('sect.confirmUnally', { name: label }), () => void this.doUnally(targetSectId));
  }

  private async doUnally(targetSectId: string): Promise<void> {
    this.closeModal();
    try {
      await this.cb.worldApi.unallySect(this.cb.worldId, targetSectId);
      if (this.sect) await this.loadMySect(this.sect.sectId);
      this.render();
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
  }

  // â”€â”€ Modals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  private showSectPickModal(sects: SectView[], onPick: (sectId: string) => void, emptyKey: 'sect.noSects' | 'sect.noAllies'): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(320, w - 32);
    const mh = Math.min(320, h - 80);
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);
    this.modalHits.push({ rect: { x: 0, y: 0, w, h }, action: () => this.closeModal() });

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    if (sects.length === 0) {
      const lbl = txt(t(emptyKey), 13, C.dark);
      lbl.anchor.set(0.5, 0.5); lbl.x = mx + mw / 2; lbl.y = my + mh / 2;
      ml.addChild(lbl);
      return;
    }

    let cy = my + 10;
    for (const s of sects.slice(0, 6)) {
      const row = sketchPanel(mw - 16, 36, { fill: 0xfaf9f5, border: C.mid, seed: seedFor(cy, 0, mw - 16) });
      row.x = mx + 8; row.y = cy;
      ml.addChild(row);
      const lbl = txt(`[${s.tag}] ${s.name} (${s.memberFamilyCount})`, 12, C.dark);
      lbl.x = mx + 14; lbl.y = cy + 10;
      ml.addChild(lbl);
      const sid = s.sectId;
      this.modalHits.push({ rect: { x: mx + 8, y: cy, w: mw - 16, h: 36 }, action: () => onPick(sid) });
      cy += 40;
    }
  }

  private showConfirm(msg: string, onOk: () => void): void {
    const { w, h } = this;
    const ml = this.modalLayer;
    ml.removeChildren();
    this.modalHits = [];
    this.modalOpen = true;

    const mw = Math.min(300, w - 40);
    const mh = 120;
    const mx = (w - mw) / 2;
    const my = (h - mh) / 2;

    const dim = new PIXI.Graphics();
    dim.beginFill(0x000000, 0.35).drawRect(0, 0, w, h).endFill();
    ml.addChild(dim);

    const panel = sketchPanel(mw, mh, { fill: C.paper, border: C.dark, seed: seedFor(0, 0, mw) });
    panel.x = mx; panel.y = my;
    ml.addChild(panel);

    const lbl = txt(msg, 13, C.dark);
    lbl.anchor.set(0.5, 0); lbl.x = mx + mw / 2; lbl.y = my + 16;
    (lbl.style as PIXI.TextStyle).wordWrap = true;
    (lbl.style as PIXI.TextStyle).wordWrapWidth = mw - 24;
    (lbl.style as PIXI.TextStyle).align = 'center';
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
    const cl = txt('âœ•', 13, C.dark);
    cl.anchor.set(0.5, 0.5); cl.x = mx + mw / 2 + 48; cl.y = my + mh - 22;
    ml.addChild(cl);
    this.modalHits.push({ rect: { x: cancelBtn.x, y: cancelBtn.y, w: 80, h: 28 }, action: () => this.closeModal() });
  }

  private closeModal(): void {
    this.modalLayer.removeChildren();
    this.modalHits = [];
    this.modalOpen = false;
  }

  // â”€â”€ Toast â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        ALREADY_IN_SECT:    t('sect.err.alreadyIn'),
        SECT_FULL:          t('sect.err.full'),
        NOT_IN_SECT:        t('sect.err.notIn'),
        NO_PERMISSION:      t('sect.err.noPermission'),
        NOT_FOUND:          t('sect.err.notFound'),
        ALLY_CAP_REACHED:   t('sect.err.allyCap'),
        INSUFFICIENT_FUNDS: t('sect.err.funds'),
        BAD_REQUEST:        t('sect.err.badReq'),
      };
      return map[e.code] ?? e.message;
    }
    return String(e);
  }

  // â”€â”€ Scene interface â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
