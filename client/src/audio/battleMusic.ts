// 对局里该放哪条轨（AUDIO_DESIGN.md §2.3）——一个从对局时钟到 `MusicTrack` 的纯函数。
//
// **切点是 ×2 回墨阶段（6 分钟），由引擎的同一个常数定义**，而不是这里另写一个 360：对局节奏
// 由 `ACCEL_THRESHOLD_*_TICKS` 决定（BALANCE.md §3），音乐要跟的正是那个节奏，所以平衡改了阈值，
// 音乐跟着走，不需要有人记得来这里改。选 6 分钟而不是 3 分钟（×1.5）或 10 分钟（×4）是项目所有者
// 拍的板：×1.5 几乎听不出变化，而很多对局打不到 10 分钟，后期曲会几乎没人听到。
//
// **只读，不进确定性**（AUDIO_DESIGN.md §6）：调用方传进来的是渲染侧已经看到的 tick 数，这里
// 不碰 `GameState`，也不往引擎里加任何事件。阶段切换不需要引擎通知——场景每帧被问一次 `music`，
// 播放器对「还是同一条轨」是空操作，所以一次比较就是全部的接线。
import { ACCEL_THRESHOLD_2_TICKS } from '@nw/engine/config';
import type { MusicTrack } from './types';

/** `elapsedTicks` 时刻的对局该放的轨。 */
export function battleTrack(elapsedTicks: number): MusicTrack {
  return elapsedTicks >= ACCEL_THRESHOLD_2_TICKS ? 'bgm.battle.late' : 'bgm.battle.early';
}
