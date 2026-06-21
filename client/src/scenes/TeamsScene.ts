// TeamsScene — SLG 进攻队伍管理（G3-2c §16.2）
//
// 列出 5 个进攻布阵模板槽位（committed 兵力 / 空）。点槽位进 DefenseEditorScene（attack 模式）编辑该队。
// 队伍是「可保存的进攻布阵模板 + 并发上限」：出征围攻时挂一支队，committed 兵力从池扣除。
// 数据权威在 worldsvc（getTeams/setTeams）；本场仅做槽位列表 + 跳转编辑，命名按槽位固定（v1）。

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor } from '../render/sketchUi';
import type { WorldApiClient, TeamTemplate } from '../net/WorldApiClient';

/** 队伍槽位上限（UI 常量；服务端 SIEGE_TEAM_CAP 为权威）。 */
export const TEAM_CAP = 5;

export interface TeamsCallbacks {
  onBack(): void;
  /** 进入某槽位的进攻布阵编辑器。 */
  onEditTeam(teamId: string, teamName: string): void;
  worldApi: WorldApiClient;
  worldId: string;
}

/** 槽位固定 id/名（v1 不做自定义命名）。 */
export function teamSlotId(i: number): string {
  return `t${i + 1}`;
}
export function teamSlotName(i: number): string {
  return t('world.team.slot').replace('{n}', String(i + 1));
}

const HEADER_H = 46;
const PAD = 12;
const ROW_H = 56;
const ROW_GAP = 8;

export class TeamsScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: TeamsCallbacks;

  private teams: TeamTemplate[] = [];
  private loading = true;
  private destroyed = false;

  private bodyLayer!: PIXI.Container;
  private hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];
  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: TeamsCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.container = new PIXI.Container();

    this.container.addChild(buildPaperBackground('teams', this.w, this.h));
    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.render();
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const teams = await this.cb.worldApi.getTeams(this.cb.worldId);
      if (!this.destroyed) this.teams = teams;
    } catch { /* offline — show empty slots */ }
    this.loading = false;
    if (!this.destroyed) this.render();
  }

  private committed(army: TeamTemplate['army']): number {
    return army.reduce((s, e) => s + Math.max(0, Math.floor(e.initialHp ?? 0)), 0);
  }

  private render(): void {
    this.bodyLayer.removeChildren();
    this.hits = [];
    const { w } = this;

    // Header
    const header = sketchPanel(w, HEADER_H, { fill: C.paper, border: C.mid, seed: seedFor(0, 0, w) });
    this.bodyLayer.addChild(header);
    const back = txt(t('world.back'), 13, C.accent);
    back.x = PAD; back.y = (HEADER_H - back.height) / 2;
    this.bodyLayer.addChild(back);
    this.hits.push({ rect: { x: 0, y: 0, w: 90, h: HEADER_H }, action: () => this.cb.onBack() });
    const title = txt(t('world.team.title'), 14, C.dark, true);
    title.anchor.set(0.5, 0);
    title.x = w / 2; title.y = (HEADER_H - title.height) / 2;
    this.bodyLayer.addChild(title);

    if (this.loading) {
      const lbl = txt(t('world.loading'), 13, C.mid);
      lbl.anchor.set(0.5, 0.5); lbl.x = w / 2; lbl.y = this.h / 2;
      this.bodyLayer.addChild(lbl);
      return;
    }

    // Slot rows
    let y = HEADER_H + PAD;
    for (let i = 0; i < TEAM_CAP; i++) {
      const id = teamSlotId(i);
      const team = this.teams.find((tm) => tm.id === id);
      const filled = !!team && team.army.length > 0;
      const rowW = w - PAD * 2;
      const panel = sketchPanel(rowW, ROW_H, {
        fill: C.paper, border: filled ? C.accent : C.mid, width: filled ? 2 : 1.3,
        seed: seedFor(PAD, y, rowW),
      });
      panel.x = PAD; panel.y = y;
      this.bodyLayer.addChild(panel);

      const name = txt(team?.name || teamSlotName(i), 14, C.dark, true);
      name.x = PAD + 12; name.y = y + 10;
      this.bodyLayer.addChild(name);

      const sub = filled
        ? `${t('world.defense.garrison').replace('{n}', String(team!.army.length))}   ${t('world.team.committed').replace('{n}', String(this.committed(team!.army)))}`
        : t('world.team.empty');
      const subLbl = txt(sub, 11, filled ? C.mid : C.light);
      subLbl.x = PAD + 12; subLbl.y = y + 30;
      this.bodyLayer.addChild(subLbl);

      // Edit button (right)
      const btnW = 64, btnH = 30;
      const btn = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(w, y, btnW) });
      btn.x = w - PAD - btnW - 8; btn.y = y + (ROW_H - btnH) / 2;
      this.bodyLayer.addChild(btn);
      const btnLbl = txt(t('world.team.edit'), 12, C.light, true);
      btnLbl.anchor.set(0.5, 0.5);
      btnLbl.x = btn.x + btnW / 2; btnLbl.y = btn.y + btnH / 2;
      this.bodyLayer.addChild(btnLbl);

      const name2 = team?.name || teamSlotName(i);
      this.hits.push({
        rect: { x: PAD, y, w: rowW, h: ROW_H },
        action: () => this.cb.onEditTeam(id, name2),
      });
      y += ROW_H + ROW_GAP;
    }
  }

  private handleDown(x: number, y: number): void {
    for (const { rect, action } of this.hits) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) {
        action();
        return;
      }
    }
  }

  update(): void { /* static list */ }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.container.destroy({ children: true });
  }
}
