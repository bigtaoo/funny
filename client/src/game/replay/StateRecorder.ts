/**
 * 状态流录制器（REPLAY_SHARE_DESIGN §2.1）。
 *
 * 输出侧录制器，对称于输入侧 {@link RecordingInputSource}：引擎每推进一个 tick（**真打 或
 * 看回放都算**）就抓一份当帧实体可视状态。接入点是渲染层每帧本就读 `engine.state` 的地方
 * （{@link GameRenderer}），对引擎零侵入。
 *
 * 单槽 ring：模块级单例只保最近一局（仿 {@link ReplayStore} 的「最近 N 局」做法，单槽即 N=1）。
 * 分享只发生在「刚结算 / 刚看完回放」两个时机，此时状态流本就在内存里 —— 分享按钮按下读内存
 * 即得，**无需重跑、无需服务端复算**。
 *
 * 若当前看的本来就是别人分享来的状态流（哑播放器场景），则 {@link adopt} 直接持有原始编码流，
 * 连抓都不用、原样转发。
 */

import { BOARD_COLS, BOARD_ROWS, ATTACK_LANES } from '../config';
import { TICK_RATE } from '../math/fixed';
import { sideToOwner } from '../types';
import type { GameState } from '../GameState';
import {
  STATE_SCHEMA_VERSION,
  encodeStateReplay,
  quantizePos,
  quantizeHp,
  type EncodedStateReplay,
  type StateFrame,
  type StateReplayHeader,
  type StateUnit,
  type StateBuilding,
  type StateBase,
} from './StateReplay';

/**
 * 单局最大采样帧数（体量护栏）。30Hz 下约 ≈ 6.7 分钟；超限停止采样并标记 `capped`，
 * 已采样部分仍可分享（服务端另有 blob 体量上限二次把关）。最终上限实测再定（§7）。
 */
const MAX_FRAMES = 12000;

export interface BuildStateReplayOverrides {
  mode?: string;
  /** 双方展示名（HUD 标签）；缺省按 side 占位。 */
  players?: { name: string; side: 0 | 1 }[];
  /** 胜方 owner（0/1），-1 平局/未知；缺省用录制期 game_over 捕获的值。 */
  winner?: number;
}

class StateRecorder {
  private frames: StateFrame[] = [];
  private lastTick = -1;
  private capped = false;
  private winner = -1;
  /** 基地满血基准（首帧锚定），用于裂痕比例。 */
  private baseMaxHp: [number, number] = [0, 0];

  /** 别人分享来的原始编码流（哑播放器 adopt）——存在时分享原样转发，不读 frames。 */
  private adopted: EncodedStateReplay | null = null;

  /** 新一局/新一段回放开始：清空单槽。GameRenderer.buildSceneGraph 调用。 */
  reset(): void {
    this.frames = [];
    this.lastTick = -1;
    this.capped = false;
    this.winner = -1;
    this.baseMaxHp = [0, 0];
    this.adopted = null;
  }

  /** 持有别人分享来的状态流（哑播放器），令再次分享原样转发。 */
  adopt(enc: EncodedStateReplay): void {
    this.adopted = enc;
  }

  /** 录制期捕获胜方（game_over/game_draw 时由渲染层调用）。 */
  setWinner(winner: number): void {
    this.winner = winner;
  }

  /** 当前是否有可分享内容（采样到帧 或 已 adopt）。 */
  get hasContent(): boolean {
    return this.adopted !== null || this.frames.length > 0;
  }

  /**
   * 抓一帧。引擎 tick 推进后调用；同一 tick 重复调用（无推进的渲染帧）自动跳过，
   * 检测到 tick 回退（elapsedTicks 归零）视为新一局自动 reset。
   */
  capture(state: GameState): void {
    if (this.adopted) return; // 看分享流时不另抓
    const tick = state.elapsedTicks;
    if (tick < this.lastTick) this.reset();
    if (tick === this.lastTick && this.frames.length > 0) return;
    if (this.capped) return;

    if (this.frames.length === 0) {
      // 首帧锚定基地满血基准。
      this.baseMaxHp = [
        Math.max(1, quantizeHp(state.bottomPlayer.baseHp)),
        Math.max(1, quantizeHp(state.topPlayer.baseHp)),
      ];
    }

    this.lastTick = tick;
    this.frames.push(this.snapshot(state, tick));
    if (this.frames.length >= MAX_FRAMES) this.capped = true;
  }

  /**
   * 出码：把内存帧序列打包成 delta 编码录像。已 adopt 则原样返回原始流。
   * `overrides` 补 header 的 mode/players/winner（录制点不知道这些上下文，分享点传入）。
   */
  build(overrides: BuildStateReplayOverrides = {}): EncodedStateReplay | null {
    if (this.adopted) return this.adopted;
    if (this.frames.length === 0) return null;

    const players: StateReplayHeader['players'] =
      overrides.players ?? [
        { name: '', side: 0 },
        { name: '', side: 1 },
      ];

    const header: StateReplayHeader = {
      schemaVersion: STATE_SCHEMA_VERSION,
      mode: overrides.mode ?? 'unknown',
      tickRate: TICK_RATE,
      endTick: this.lastTick,
      winner: overrides.winner ?? this.winner,
      board: { cols: BOARD_COLS, rows: BOARD_ROWS, lanes: [...ATTACK_LANES] },
      players,
    };

    return encodeStateReplay({ header, frames: this.frames });
  }

  // ── 私有：抓一帧满状态 ─────────────────────────────────────────────────────

  private snapshot(state: GameState, tick: number): StateFrame {
    const units: StateUnit[] = [];
    for (const u of state.board.units.values()) {
      units.push({
        id: u.id,
        type: u.unitType,
        side: sideToOwner(u.side),
        col: quantizePos(u.colExact),
        row: quantizePos(u.rowExact),
        hp: quantizeHp(u.hp),
        maxHp: quantizeHp(u.maxHp),
        state: u.state,
      });
    }

    const buildings: StateBuilding[] = [];
    for (const b of state.board.buildings.values()) {
      buildings.push({
        id: b.id,
        type: b.buildingType,
        side: sideToOwner(b.side),
        col: b.col,
        row: b.row,
        hp: quantizeHp(b.hp),
        maxHp: quantizeHp(b.maxHp),
      });
    }

    const bases: StateBase[] = [
      { owner: 0, hp: quantizeHp(state.bottomPlayer.baseHp), maxHp: this.baseMaxHp[0] },
      { owner: 1, hp: quantizeHp(state.topPlayer.baseHp), maxHp: this.baseMaxHp[1] },
    ];

    return { tick, units, buildings, bases };
  }
}

/** 模块级单槽单例（最近一局）。 */
export const stateRecorder = new StateRecorder();
