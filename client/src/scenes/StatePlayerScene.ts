import * as PIXI from 'pixi.js-legacy';
import { Scene } from './SceneManager';
import { ILayout } from '../layout/ILayout';
import { BoardView } from '../render/BoardView';
import { UnitView } from '../render/UnitView';
import { BuildingView } from '../render/BuildingView';
import { VFXSystem } from '../render/VFXSystem';
import { Side, UnitType, UnitState, BuildingType, ownerToSide, type OwnerId } from '../game';
import { t } from '../i18n';
import { ui, sketchPanel, seedFor } from '../render/sketchUi';
import { stateRecorder } from '../game/replay/StateRecorder';
import type {
  StateReplay,
  StateFrame,
  StateUnit,
  StateBuilding,
  EncodedStateReplay,
} from '../game/replay/StateReplay';

/**
 * 哑状态播放器（REPLAY_SHARE_DESIGN §4.2）。
 *
 * **不加载引擎、不要 config、不要账号** —— 只把 {@link StateReplay} 每帧画出来。复用渲染资产
 * （SketchPen 棋盘 / UnitView / VFX），但数据源是状态流而非引擎。落地页轻量化：无引擎/数值
 * 模拟，分享页非玩家也能秒开。
 *
 * transport 覆盖层同 ReplayScene（播放/暂停、1×/2×/4×、进度条）；退出三向：重放 / 返回登录 /
 * 进大厅试玩（后两个是拉新入口）。
 */
export interface StatePlayerSceneCallbacks {
  /** 进大厅试玩（拉新）。 */
  onPlayDemo(): void;
  /** 返回登录（拉新）。 */
  onBackToLogin(): void;
}

const SPEEDS = [1, 2, 4] as const;

/** UnitView.sync 实际读取的最小单位结构（结构化喂数据，无需真引擎 Unit）。 */
interface UnitLike {
  id: number;
  unitType: UnitType;
  side: Side;
  colExact: number;
  rowExact: number;
  hp: number;
  maxHp: number;
  state: UnitState;
}
/** BuildingView.sync 实际读取的最小建筑结构。 */
interface BuildingLike {
  id: number;
  buildingType: BuildingType;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
}
/** UnitView/BuildingView.sync 只读 board.units / board.buildings 两个 Map。 */
interface BoardLike {
  units: Map<number, UnitLike>;
  buildings: Map<number, BuildingLike>;
}

export class StatePlayerScene implements Scene {
  readonly container: PIXI.Container;

  private readonly boardView: BoardView;
  private readonly unitView: UnitView;
  private readonly buildingView: BuildingView;
  private readonly vfx: VFXSystem;

  private readonly frames: StateFrame[];
  private readonly endTick: number;
  private readonly tickRate: number;

  /** 墙钟（秒）× tickRate = 当前 tick 位置；驱动帧插值与进度。 */
  private clock = 0;
  private playing = true;
  private ended = false;
  private speedIdx = 0;

  /** 单调游标：当前墙钟所处的帧下标（frames[cursor].tick <= curTick）。 */
  private cursor = 0;
  /** 已派发过特效的帧下标（避免每渲染帧重复派发死亡/裂痕）。 */
  private effectIdx = 0;

  private readonly overlay = new PIXI.Container();
  private playLabel!: PIXI.Text;
  private speedLabel!: PIXI.Text;
  private progressFill!: PIXI.Graphics;
  private endPanel!: PIXI.Container;
  private readonly barX: number;
  private readonly barY: number;
  private readonly barW: number;

  constructor(
    private readonly layout: ILayout,
    replay: StateReplay,
    private readonly cb: StatePlayerSceneCallbacks,
    /** 原始编码流（若有）：adopt 进单槽，令「再分享」原样转发（§2.1）。 */
    encoded?: EncodedStateReplay,
  ) {
    this.container = new PIXI.Container();
    if (encoded) stateRecorder.adopt(encoded);

    this.frames = replay.frames;
    this.endTick = Math.max(1, replay.header.endTick);
    this.tickRate = Math.max(1, replay.header.tickRate);

    this.boardView = new BoardView(layout);
    this.unitView = new UnitView(this.boardView, Side.Bottom, null);
    this.buildingView = new BuildingView(this.boardView);
    this.vfx = new VFXSystem();

    this.container.addChild(this.boardView.container);
    this.container.addChild(this.unitView.container);
    this.container.addChild(this.buildingView.container);
    this.container.addChild(this.vfx.container);

    const w = layout.designWidth;
    this.barW = Math.round(w * 0.5);
    this.barX = Math.round((w - this.barW) / 2);
    this.barY = Math.round(layout.designHeight * 0.045);
    this.buildPlayerLabels(replay);
    this.buildOverlay(replay);
    this.container.addChild(this.overlay);

    // 首帧即渲染一帧，避免开场空屏。
    this.renderAt();
  }

  update(dt: number): void {
    if (this.playing && !this.ended) {
      this.clock += dt * SPEEDS[this.speedIdx]!;
      if (this.clock * this.tickRate >= this.endTick) {
        this.clock = this.endTick / this.tickRate;
        this.ended = true;
        this.playing = false;
      }
      this.renderAt();
    }
    // 渲染资产的自有动画（建筑摆动 / VFX）持续推进。
    this.boardView.update(dt);
    this.buildingView.update(dt);
    this.vfx.update(dt);
    this.refreshOverlay();
  }

  destroy(): void {
    this.vfx.destroy();
    this.overlay.removeAllListeners();
    this.container.removeAllListeners();
  }

  // ── 帧推进 + 插值 ──────────────────────────────────────────────────────────

  private renderAt(): void {
    if (this.frames.length === 0) return;
    const curTick = this.clock * this.tickRate;

    // 单调推进游标至 frames[cursor].tick <= curTick < frames[cursor+1].tick。
    while (this.cursor < this.frames.length - 1 && this.frames[this.cursor + 1]!.tick <= curTick) {
      this.cursor++;
    }
    // 倒带（重放）时回退游标。
    while (this.cursor > 0 && this.frames[this.cursor]!.tick > curTick) this.cursor--;

    const a = this.frames[this.cursor]!;
    const b = this.frames[Math.min(this.cursor + 1, this.frames.length - 1)]!;
    const span = b.tick - a.tick;
    const frac = span > 0 ? Math.max(0, Math.min(1, (curTick - a.tick) / span)) : 0;

    // 派发自上次以来跨过的整帧的离散特效（死亡/受击/裂痕/建筑摧毁）。
    if (this.cursor > this.effectIdx) {
      for (let i = this.effectIdx; i < this.cursor; i++) {
        this.emitEffects(this.frames[i]!, this.frames[i + 1]!);
      }
      this.effectIdx = this.cursor;
    } else if (this.cursor < this.effectIdx) {
      // 重放：重置特效游标，不补派发。
      this.effectIdx = this.cursor;
    }

    // UnitView/BuildingView.sync 只读 board.units / board.buildings 两个 Map；用结构化对象
    // 喂数据、转型到其参数类型即可，无需真引擎 Board（哑播放器不跑引擎）。
    type BoardArg = Parameters<UnitView['sync']>[0];
    this.unitView.sync(this.buildBoard(a, b, frac) as unknown as BoardArg, 0);
    this.buildingView.sync({ buildings: this.buildBuildings(a) } as unknown as BoardArg);
  }

  /** 构造插值后的 board（单位坐标在 a→b 之间线性插值，未配对实体取自身帧值）。 */
  private buildBoard(a: StateFrame, b: StateFrame, frac: number): BoardLike {
    const bById = new Map<number, StateUnit>();
    for (const u of b.units) bById.set(u.id, u);

    const units = new Map<number, UnitLike>();
    for (const u of a.units) {
      const nb = bById.get(u.id);
      const col = nb ? u.col + (nb.col - u.col) * frac : u.col;
      const row = nb ? u.row + (nb.row - u.row) * frac : u.row;
      units.set(u.id, {
        id: u.id,
        unitType: u.type as UnitType,
        side: ownerToSide(u.side as OwnerId),
        colExact: col,
        rowExact: row,
        hp: u.hp,
        maxHp: u.maxHp,
        state: u.state as UnitState,
      });
    }
    return { units, buildings: this.buildBuildings(a) };
  }

  private buildBuildings(f: StateFrame): Map<number, BuildingLike> {
    const m = new Map<number, BuildingLike>();
    for (const b of f.buildings) {
      m.set(b.id, {
        id: b.id,
        buildingType: b.type as BuildingType,
        col: b.col,
        row: b.row,
        hp: b.hp,
        maxHp: b.maxHp,
      });
    }
    return m;
  }

  /** 由相邻两帧的差异合成离散特效。 */
  private emitEffects(a: StateFrame, b: StateFrame): void {
    const bUnits = new Map(b.units.map((u) => [u.id, u] as const));
    for (const u of a.units) {
      const nb = bUnits.get(u.id);
      if (!nb) {
        // 单位消失 → 死亡动画 + 烟尘。
        this.unitView.playDeathEffect(u.id);
        const p = this.boardView.gridToScreen(u.col, u.row);
        this.vfx.play('death_unit', p.x, p.y, 0x222222);
      } else if (nb.hp < u.hp) {
        this.unitView.showHpBar(u.id);
        this.unitView.playHitEffect(u.id);
        const hit = this.unitView.getHitPoint(u.id);
        if (hit) this.vfx.play('hit', hit.x, hit.y, 0xffffff);
      }
    }

    const bBuildings = new Map(b.buildings.map((x) => [x.id, x] as const));
    for (const x of a.buildings) {
      if (!bBuildings.has(x.id)) {
        this.buildingView.playDestroyEffect(x.id);
        const p = this.boardView.gridToScreen(x.col, x.row);
        this.vfx.play('death_building', p.x, p.y, 0x222222);
      }
    }

    const aBases = new Map(a.bases.map((x) => [x.owner, x] as const));
    for (const nb of b.bases) {
      const oa = aBases.get(nb.owner);
      if (oa && nb.hp < oa.hp) {
        this.boardView.playBaseCrackEffect(nb.owner, nb.hp, Math.max(1, nb.maxHp));
      }
    }
  }

  // ── 覆盖层 ─────────────────────────────────────────────────────────────────

  private buildPlayerLabels(replay: StateReplay): void {
    const { designWidth: w, designHeight: h } = this.layout;
    const fs = Math.max(11, Math.round(h * 0.024));
    for (const p of replay.header.players) {
      const name = p.name || (p.side === 0 ? t('stateplayer.you') : t('stateplayer.opponent'));
      const label = new PIXI.Text(name, {
        fontSize: fs,
        fill: p.side === 0 ? 0x2244aa : 0xaa2222,
        fontWeight: 'bold',
        fontFamily: 'monospace',
      });
      label.anchor.set(p.side === 0 ? 0 : 1, 0);
      label.x = p.side === 0 ? Math.round(w * 0.04) : Math.round(w * 0.96);
      label.y = Math.round(h * 0.11);
      this.overlay.addChild(label);
    }
  }

  private buildOverlay(replay: StateReplay): void {
    const { designWidth: w } = this.layout;
    const btnH = Math.round(this.layout.designHeight * 0.05);

    const track = new PIXI.Graphics();
    track.beginFill(0x000000, 0.25);
    track.drawRoundedRect(this.barX, this.barY, this.barW, 8, 4);
    track.endFill();
    this.progressFill = new PIXI.Graphics();
    this.overlay.addChild(track, this.progressFill);

    const tag = new PIXI.Text(`▶ ${t('stateplayer.tag')}`, {
      fontSize: Math.round(btnH * 0.5),
      fill: 0x2244aa,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    tag.x = Math.round(w * 0.04);
    tag.y = this.barY - 2;
    this.overlay.addChild(tag);

    const rowY = this.barY + 18;
    const gap = Math.round(w * 0.02);
    const playW = Math.round(w * 0.2);
    const speedW = Math.round(w * 0.18);
    const totalW = playW + speedW + gap;
    let x = Math.round((w - totalW) / 2);

    this.playLabel = this.makeButton(x, rowY, playW, btnH, t('replay.pause'), () => {
      if (this.ended) return;
      this.playing = !this.playing;
    });
    x += playW + gap;
    this.speedLabel = this.makeButton(
      x, rowY, speedW, btnH, t('replay.speed', { n: SPEEDS[this.speedIdx]! }),
      () => { this.speedIdx = (this.speedIdx + 1) % SPEEDS.length; },
    );

    this.buildEndPanel(replay);
  }

  /** 结算面板（播放结束时显示）：胜负横幅 + 退出三向。 */
  private buildEndPanel(replay: StateReplay): void {
    const { designWidth: w, designHeight: h } = this.layout;
    this.endPanel = new PIXI.Container();
    this.endPanel.visible = false;

    const winner = replay.header.winner;
    const headline =
      winner === -1
        ? t('stateplayer.ended')
        : winner === 0
          ? t('stateplayer.bottomWon')
          : t('stateplayer.topWon');
    const banner = new PIXI.Text(headline, {
      fontSize: Math.round(h * 0.05),
      fill: 0x2c2c2a,
      fontWeight: 'bold',
      fontFamily: 'serif',
      align: 'center',
    });
    banner.anchor.set(0.5, 0.5);
    banner.x = w / 2;
    banner.y = h * 0.42;
    this.endPanel.addChild(banner);

    const btnW = Math.round(w * 0.6);
    const btnH = Math.round(h * 0.07);
    const btnX = (w - btnW) / 2;
    let y = h * 0.52;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.replay'), () => this.restart(), this.endPanel);
    y += btnH + h * 0.018;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.playDemo'), () => this.cb.onPlayDemo(), this.endPanel);
    y += btnH + h * 0.018;
    this.makeButton(btnX, y, btnW, btnH, t('stateplayer.backToLogin'), () => this.cb.onBackToLogin(), this.endPanel);

    this.overlay.addChild(this.endPanel);
  }

  private restart(): void {
    this.clock = 0;
    this.cursor = 0;
    this.effectIdx = 0;
    this.ended = false;
    this.playing = true;
    this.endPanel.visible = false;
    this.renderAt();
  }

  private makeButton(
    x: number, y: number, w: number, h: number, text: string, onTap: () => void,
    parent: PIXI.Container = this.overlay,
  ): PIXI.Text {
    const bg = sketchPanel(w, h, { fill: ui.dark, border: ui.btnOff, width: 2, fillAlpha: 0.9, seed: seedFor(x, y, w) });
    bg.x = x;
    bg.y = y;
    bg.interactive = true;
    bg.cursor = 'pointer';
    bg.on('pointertap', onTap);

    const label = new PIXI.Text(text, {
      fontSize: Math.round(h * 0.42),
      fill: 0xffffff,
      fontWeight: 'bold',
      fontFamily: 'monospace',
    });
    label.anchor.set(0.5, 0.5);
    label.x = x + w / 2;
    label.y = y + h / 2;

    parent.addChild(bg, label);
    return label;
  }

  private refreshOverlay(): void {
    const frac = Math.min(1, (this.clock * this.tickRate) / this.endTick);
    this.progressFill.clear();
    if (frac > 0) {
      this.progressFill.beginFill(0x2244aa, 0.9);
      this.progressFill.drawRoundedRect(this.barX, this.barY, Math.max(8, this.barW * frac), 8, 4);
      this.progressFill.endFill();
    }
    this.playLabel.text = this.playing ? t('replay.pause') : t('replay.play');
    this.speedLabel.text = t('replay.speed', { n: SPEEDS[this.speedIdx]! });
    this.endPanel.visible = this.ended;
  }
}
