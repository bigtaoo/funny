// BGM 运行时（AUDIO_DESIGN.md §2.3 / §7 第 7 步），平台中立的那一半。
//
// **两个长期存活的 deck，一条规则：听到的东西每一次改变，都是它们之间的一次等功率交叉淡入。**
// 这一步要做的两件事其实是同一个操作：
//
//   1. **闭合循环。** `el.loop = true`（微信是 `InnerAudioContext.loop`）在这里用不了：MP3 的
//      两端都被补齐到帧边界，所以无论区段怎么切，样本级精确回绕都不存在——而所有原生循环 API
//      要么样本级精确、要么不循环。于是播放器在 `lengthS - XFADE_S` 处**把同一个文件放到另一个
//      deck 上从头开始**，然后淡过去。这也正是两条轨的验收门禁是 `xfade_band_diff`（头尾在 2 秒
//      窗口内音色相容）而不是 `step_db`（末样本紧挨首样本）的原因：后者是一条本客户端没有的
//      机制的门禁，前者是唯一**做得到**的要求。见 `tools/audio-pipeline/audit.py` 的头注释。
//   2. **换轨。** 同一个机制，只是进来的 deck 上换个文件。
//
// 因为回绕复用了换轨的机器，这个文件里只有**一条**包络，两种行为被同一批用例覆盖。
// `XFADE_S` 与资产管线共享——见 `musicCatalogue.ts` 里那一条为什么不许单边改动。
//
// **回绕的时刻是读回来的，不是数出来的。** `update` 收 `dtMs`，但只用它推包络和 ducking 的衰减；
// 回绕的判据来自正在播的那个 deck 自己的 `position()`。累积时钟会在每一次卡帧、每一次切后台、
// 每一次音频中断上与真实流漂移，而且是**静默**漂移——症状是交叉淡入起在了它被测量的那个接缝
// 之前或之后，听起来像一条切坏了的循环，而不像一个计数器的 bug。
//
// **与 daydayup 的同名文件有三处不同，都是删减而不是新增：**
//  - **deck 只有一个增益入口 `setGain`。** 那边 web 侧有一个上游的 music `GainNode`、微信侧没有
//    音频图，于是"总线音量"和"本 deck 的淡入位置"是两个分别存储、各自触发重算的量。这里两个
//    平台都把整个乘积 `fade × bus × duck` 在**本文件**里算完再推给 deck，于是 deck 变哑、乘积
//    只在一处成形，两个平台的 deck 实现也不再有形状差异。
//  - **没有 `invalidate()`。** 那边需要它是因为音乐在一个可能还没下载完的**分包**里；本项目
//    按 ASSET_PACKAGING §4 方案 A 把全部资源托管在 CDN（AUDIO_DESIGN.md §5 那条被划掉的"首包
//    体积"），没有会迟到的分包，所以那是一条没人会调用的恢复路径。
//  - **多了 ducking**（§4 的可选项 P2），因为它恰好是同一条包络的第三个用户。
//
// 确定性（AUDIO_DESIGN.md §6）：这里不读不写 `GameState`，音乐明确不参与确定性，所以允许自由
// 使用墙钟时间。
import type { MusicTrack } from './types';
import { MUSIC_CATALOGUE, XFADE_S } from './musicCatalogue';

/**
 * 一个流式 deck：一条长期存活的音频流，可以被指向某个文件、调增益、暂停、停止。
 *
 * **刻意窄**（同本仓库 `ContextAudioBusDeps` 的两问约定）——它就是音乐需要的全部平台表面，而两个
 * 实现之间没有任何共享代码：
 *
 *  - web（`platform/web/webMusicDeck.ts`）：一个 `Audio` 元素经 `createMediaElementSource`
 *    进入本 deck 自己的 `GainNode`。**不能改用 `audioEl.volume`**——iOS Safari 上那个属性是只读的
 *    （赋值被静默忽略），而交叉淡入每帧都要写它，所以在 iOS 上整条淡入会变成硬切。
 *  - 微信（`platform/wechat/wechatMusicDeck.ts`）：一个 `InnerAudioContext`，它**没有音频图**，
 *    所以增益只能写进那唯一的 `.volume`。这也是本仓库唯一一个 `InnerAudioContext`——SFX 走的是
 *    `wx.createWebAudioContext()`（§5 订正 2），而**故意与它无关**：一个缺 `createWebAudioContext`
 *    的低版本基础库应该丢掉 SFX 样本，不该连音乐一起丢掉。
 */
export interface MusicDeck {
  /**
   * 把这个 deck 指向 `path` 并**从头**开始播。
   *
   * 没有 offset 参数，循环也不需要一个：回绕是在第一个 deck 走到 `lengthS - XFADE_S` 的那一刻
   * 让第二个 deck 从 0 播自己的文件，同时第一个把它被测量过的尾巴放完。在两个目标平台上，
   * 对一条元数据还没到齐的流做 seek 都不可靠——所以「不需要 seek」是一个特性。
   */
  play(path: string): void;
  /** 本 deck 的最终输出增益，0..1。播放器每帧写一次（`fade × bus × duck` 的乘积）。 */
  setGain(level: number): void;
  /** 停止并释放流。deck 本身保持可复用。 */
  stop(): void;
  /**
   * 已经播到第几秒；**没在播**（或流还没报出位置）时是 `null`。
   *
   * 两者都返回 `null` 是刻意的：一条流启动前的那几帧与"没在播"无法区分，而它们的含义相同——
   * 现在还做不出回绕判断。
   */
  position(): number | null;
  /** 保持位置地暂停/恢复——web 的失焦、微信的 `onHide` 与音频中断。与 `stop` 不同：被 hold 住的
   *  deck 恢复时接着刚才那一拍。 */
  setPaused(paused: boolean): void;
}

export interface MusicPlayerDeps {
  /** 正好两个。一个不够交叉淡入，第三个永远闲着：一次过渡有两端，而过渡中途来的新过渡复用的
   *  正是那个已经在淡出的 deck（见 `begin`）。 */
  decks: readonly [MusicDeck, MusicDeck];
  /** deck 出错往哪报。省略即 `console.warn`。 */
  warn?(message: string, err: unknown): void;
}

type DeckIndex = 0 | 1;

/** 一次在飞的过渡。`t` 在 `XFADE_S` 内从 0 走到 1。两端都可能缺席：从静默起步没有 `outIdx`，
 *  淡向静默没有 `inIdx`。 */
interface Transition {
  inIdx: DeckIndex | null;
  outIdx: DeckIndex | null;
  /** 淡出那一端的 catalogue gain，单独记着：两条轨之间的交叉淡入两端的 gain 不同，而到那时
   *  `this.track` 已经被换成新的了。 */
  outGain: number;
  inGain: number;
  t: number;
}

// ── Ducking（AUDIO_DESIGN.md §4 的可选项 P2）─────────────────────────────────────────────
//
// 触发它的是哪些 cue，是**音乐这边的混音决定**，所以那张表在 `musicCatalogue.ts` 里而不是
// `cueCatalogue.ts` 里：cue 不该知道自己会不会压低音乐。

/** 压到多低。−6.9 dB——足以让揭示/结算那一下站出来，又不至于让床听起来"断了一截"。 */
const DUCK_LEVEL = 0.45;
/** 压下去要多快。比任何一个触发它的 cue 的起振都快，否则压低会晚于它要让路的那个声音。 */
const DUCK_ATTACK_MS = 80;
/** 压住多久（从最后一次触发算起）。覆盖最长的触发者（结算 stinger 约 400 ms）之后还有余量。 */
const DUCK_HOLD_MS = 500;
/** 放回来要多慢。远慢于压下去——快速恢复本身会变成一个可听见的事件，而 ducking 的整个用意是
 *  让人**不**注意到床动过。 */
const DUCK_RELEASE_MS = 700;

/** 等功率对：四分之一转的 `cos`/`sin`，于是两端在**功率**上求和为一而不是在幅度上。线性的一对
 *  会在每次淡入的中点掉约 3 dB——放在循环回绕上就是每分钟听见一次，永远。 */
function equalPower(t: number): { out: number; in: number } {
  const a = Math.max(0, Math.min(1, t)) * (Math.PI / 2);
  return { out: Math.cos(a), in: Math.sin(a) };
}

export class MusicPlayer {
  /** 承载 `track` 的那个 deck，什么都没在放时是 null。 */
  private liveIdx: DeckIndex | null = null;
  private track: MusicTrack | null = null;
  private transition: Transition | null = null;
  private paused = false;

  /** 每个 deck 的交叉淡入位置（已含该轨的 catalogue gain）。总线音量和 ducking **不在**这里面——
   *  最终增益是 `fades[i] × bus × duck`，在 {@link applyGains} 一处成形。 */
  private readonly fades: [number, number] = [0, 0];
  private bus = 0;
  private duck = 1;
  private duckHoldMs = 0;

  constructor(private readonly deps: MusicPlayerDeps) {}

  /** 播放器认为正在放的是哪条轨。纯状态查询面（给测试和 `__nwAudio`）——游戏只会**要求**一条轨，
   *  从不询问现在在放什么。 */
  get current(): MusicTrack | null {
    return this.track;
  }

  /** 是否有一次交叉淡入在飞。同上，只读。 */
  get isCrossfading(): boolean {
    return this.transition !== null;
  }

  /** 当前的 ducking 系数（1 = 没压）。同上，只读——用例靠它断言包络的形状。 */
  get duckLevel(): number {
    return this.duck;
  }

  /**
   * 一个渲染帧。`desired` 是此刻**应该**在响的轨；传一个已经在放的轨是空操作，正是这个性质让
   * 调用方可以是一次每帧的推导而不是一个事件钩子（见 `AudioBus.updateMusic` 的注释）。
   */
  update(desired: MusicTrack | null, dtMs: number): void {
    // 被 hold 住时什么都不做——包络不推，**尤其是**回绕不判：暂停的 deck 位置是停住的，
    // 于是一个在 hold 期间做出的回绕决定会在恢复的那一瞬间按陈旧证据触发。
    if (this.paused) return;
    this.advanceDuck(dtMs);
    if (this.transition) this.advance(dtMs / 1000);
    if (desired !== this.track) this.change(desired);
    else if (!this.transition) this.checkWrap();
    this.applyGains();
  }

  /** BGM 总线音量（AUDIO_DESIGN.md §4 的 `bgm` 通道 × `master` × 静音）。 */
  setBusVolume(v: number): void {
    this.bus = Math.max(0, Math.min(1, v));
    this.applyGains();
  }

  /**
   * 压低一次（某个 {@link DUCK_CUES} 里的 cue 刚播）。重复调用只是把保持窗口重新计时，
   * **不会**叠加压低量——十连揭示的十声不该把床压到听不见。
   */
  requestDuck(): void {
    this.duckHoldMs = DUCK_HOLD_MS;
  }

  /** hold/release 两个 deck（web 的 `visibilitychange`、微信的 `onHide`/音频中断）。 */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    for (const deck of this.deps.decks) {
      try {
        deck.setPaused(paused);
      } catch (err) {
        this.warn(`music: deck failed to ${paused ? 'pause' : 'resume'}`, err);
      }
    }
  }

  /** 立刻停掉两个 deck，不淡出。今天游戏不走这条路；它在这里是为了一个被拆掉的后端不会留下
   *  一条还在跑的流。 */
  stop(): void {
    this.transition = null;
    this.liveIdx = null;
    this.track = null;
    this.fades[0] = this.fades[1] = 0;
    for (const deck of this.deps.decks) {
      try {
        deck.stop();
      } catch (err) {
        this.warn('music: deck failed to stop', err);
      }
    }
  }

  // ── 过渡 ────────────────────────────────────────────────────────────────────────────────

  private change(next: MusicTrack | null): void {
    const outIdx = this.liveIdx;
    const outGain = this.track ? MUSIC_CATALOGUE[this.track].gain : 0;
    this.track = next;
    if (next === null) {
      this.liveIdx = null;
      this.begin({ inIdx: null, outIdx, inGain: 0, outGain, t: 0 });
      return;
    }
    const def = MUSIC_CATALOGUE[next];
    const inIdx = this.freeDeck(outIdx);
    this.liveIdx = inIdx;
    this.begin({ inIdx, outIdx, inGain: def.gain, outGain, t: 0 }, def.path);
  }

  /** 循环回绕：同一次过渡，只是进来的 deck 上是同一个文件。 */
  private checkWrap(): void {
    if (this.track === null || this.liveIdx === null) return;
    const def = MUSIC_CATALOGUE[this.track];
    const pos = this.deps.decks[this.liveIdx].position();
    if (pos === null) return;
    if (pos < def.lengthS - XFADE_S) return;
    const outIdx = this.liveIdx;
    const inIdx = this.freeDeck(outIdx);
    this.liveIdx = inIdx;
    this.begin({ inIdx, outIdx, inGain: def.gain, outGain: def.gain, t: 0 }, def.path);
  }

  /**
   * 一次过渡的"进来"那一端用哪个 deck：不是正在淡出的那个。
   *
   * 只有两个 deck，所以一次过渡在另一次还在飞的时候到达，只能复用那个已经在淡出的 deck——于是
   * 它先被硬停（见 `begin`）。这是真实存在的情况而不是理论情况：从大厅点进对战、两秒内又退出来
   * 就会走到。另一个选项——在淡入结束前拒绝新轨——会让音乐落后局势最多 2 秒，而一条迟到的床比
   * 一次被截短的淡入更糟：走到这一步时那次淡入本来也已经快淡到静默了。
   */
  private freeDeck(outIdx: DeckIndex | null): DeckIndex {
    if (outIdx !== null) return outIdx === 0 ? 1 : 0;
    // 什么都没在放，所以唯一可能还忙着的流是一次"淡向静默"正在排空的那个。优先另一个；
    // 如果那次淡出恰好就在我们要拿的这个 deck 上，`begin` 会把它硬停。
    const busy = this.transition?.outIdx ?? null;
    if (busy !== null) return busy === 0 ? 1 : 0;
    return 0;
  }

  private begin(next: Transition, path?: string): void {
    // 把上一次过渡还握着的 deck 退休掉，免得留下一个增益非零、却没有任何东西在驱动它的 deck。
    const stale = this.transition;
    if (stale) {
      for (const idx of [stale.inIdx, stale.outIdx]) {
        if (idx !== null && idx !== next.inIdx && idx !== next.outIdx) this.silence(idx);
      }
      // 新过渡要淡**入**的那个 deck，正是旧过渡在淡出的那个。
      if (stale.outIdx !== null && stale.outIdx === next.inIdx) this.silence(stale.outIdx);
    }
    this.transition = next;
    if (next.inIdx !== null && path !== undefined) {
      try {
        this.deps.decks[next.inIdx].play(path);
      } catch (err) {
        this.warn(`music: deck failed to start ${path}`, err);
      }
    }
    this.setFades(next);
  }

  private advance(dtS: number): void {
    const tr = this.transition!;
    tr.t += dtS / XFADE_S;
    if (tr.t < 1) {
      this.setFades(tr);
      return;
    }
    // 落定。进来的 deck 走到它的完整 catalogue gain；出去的那个被**停掉**而不是留在增益 0 上：
    // 一条挂在 0 增益上的流仍在解码，在手机上那是花在听不见的东西上的电。
    this.transition = null;
    if (tr.inIdx !== null) this.fades[tr.inIdx] = tr.inGain;
    if (tr.outIdx !== null && tr.outIdx !== tr.inIdx) this.silence(tr.outIdx);
  }

  private setFades(tr: Transition): void {
    const g = equalPower(tr.t);
    if (tr.inIdx !== null) this.fades[tr.inIdx] = g.in * tr.inGain;
    if (tr.outIdx !== null && tr.outIdx !== tr.inIdx) this.fades[tr.outIdx] = g.out * tr.outGain;
  }

  private advanceDuck(dtMs: number): void {
    const target = this.duckHoldMs > 0 ? DUCK_LEVEL : 1;
    this.duckHoldMs = Math.max(0, this.duckHoldMs - dtMs);
    if (target === this.duck) return;
    // 压下去和放回来用不同的斜率，两者都按「走完全程要多少毫秒」定义，所以改上面那两个常数
    // 就是在改听感，不需要再换算。
    const rampMs = target < this.duck ? DUCK_ATTACK_MS : DUCK_RELEASE_MS;
    const step = (1 - DUCK_LEVEL) * (dtMs / rampMs);
    this.duck = target < this.duck
      ? Math.max(target, this.duck - step)
      : Math.min(target, this.duck + step);
  }

  /** 唯一一处把最终增益算出来并推给 deck 的地方。每帧无条件跑——两次浮点写入不值得为它维护
   *  一份"谁变了"的脏标记，而那份脏标记正是增益与状态失同步的唯一可能来源。 */
  private applyGains(): void {
    const scale = this.bus * this.duck;
    for (let i = 0; i < 2; i++) {
      try {
        this.deps.decks[i].setGain(Math.max(0, Math.min(1, this.fades[i] * scale)));
      } catch (err) {
        this.warn('music: deck failed to set its level', err);
      }
    }
  }

  private silence(idx: DeckIndex): void {
    this.fades[idx] = 0;
    try {
      this.deps.decks[idx].stop();
    } catch (err) {
      this.warn('music: deck failed to stop', err);
    }
  }

  private warn(message: string, err: unknown): void {
    if (this.deps.warn) this.deps.warn(message, err);
    else console.warn(message, err);
  }
}
