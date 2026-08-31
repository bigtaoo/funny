// 一个 cue 怎么变成声音（AUDIO_DESIGN.md §4 混音）：有样本就用样本，没有就用合成音，
// 两者都过同一份 catalogue 增益、同一个并发上限。
//
// 两级阶梯：
//
//   1. `SampleBank` 里有解好的 variant → 播它，用 catalogue 的增益、带一点渲染侧音高抖动，
//      计入 `VoiceBudget`。
//   2. 没有（该 cue 只有合成音、启动预载还没解析完、或每个文件都失败了）→ `audioSynth.playCue`。
//
// 第 2 级**不是临时垫片**：见 `audioSynth.ts` 顶部列的四种常驻情形。两级都过同一个增益，
// 所以换样本不改变这个 cue 在混音里的权重。
//
// 确定性（AUDIO_DESIGN.md §6）：这里的一切跑在渲染时钟上，除了 cue id 什么都不读。variant 选择
// 和音高抖动取自注入的 `random`（默认 `Math.random`）——**绝不**用 `@nw/engine` 的 `Prng`，
// 一个声音不许扰动模拟的随机流。
import type { AudioCue } from './types';
import { playCue } from './audioSynth';
import { CUE_CATALOGUE } from './cueCatalogue';
import { VoiceBudget } from './VoiceBudget';
import type { SampleBank } from './SampleBank';

/**
 * 同时可响的样本声道数。AUDIO_DESIGN.md §5 建议的是"8 个 InnerAudioContext 轮转"，那是微信
 * 侧实例数的约束；这里是 WebAudio 侧，成本只是节点，所以给到 12。按一帧**实际能提出的请求量**
 * 定：调用方会合并同帧重复，所以一帧最多来 17 个不同的 cue，而真正会长时间重叠的只有
 * `sfx.spell.cast`（400ms）和结算 stinger。这仍然是第一版取值，不是实测结果。
 */
const DEFAULT_CAP = 12;

/** 每个声道的音高抖动幅度（正负）。小到听着还是同一个声音，大到能钝化 2-variant 的重复感。 */
const PITCH_JITTER = 0.03;

/**
 * 合并后的 cue 增益提升系数与上限。同帧十次受击变成"一次受击、更响"，而不是十次受击
 * （AUDIO_DESIGN.md §4）——取对数形状，因为事件数翻倍和响度翻倍完全不是一回事。
 */
const COALESCE_PER_DOUBLING = 0.15;
const COALESCE_MAX = 1.5;

/** 抢占时施加的淡出，让掐断读起来像一次压低而不是一声咔哒。 */
const STEAL_FADE = 0.012;

export interface CueMixerDeps {
  ctx: AudioContext;
  /** SFX 总线的 GainNode——设置页的音量住在那里（AUDIO_DESIGN.md §4），绝不在单个声道上。 */
  bus: GainNode;
  bank: SampleBank;
  cap?: number;
  random?: () => number;
}

/** `count` 个事件合并成一个 cue 时的增益倍数。 */
export function coalesceBoost(count: number): number {
  if (count <= 1) return 1;
  return Math.min(1 + COALESCE_PER_DOUBLING * Math.log2(count), COALESCE_MAX);
}

export class CueMixer {
  private readonly budget: VoiceBudget;
  private readonly random: () => number;
  /** 每个 cue 上次播的 variant 下标，用来保证下一次不同——重复疲劳在单个样本听起来不对之前
   *  很久就已经可闻了。 */
  private readonly lastVariant = new Map<AudioCue, number>();

  constructor(private readonly deps: CueMixerDeps) {
    this.budget = new VoiceBudget(deps.cap ?? DEFAULT_CAP);
    this.random = deps.random ?? Math.random;
  }

  /**
   * 播一个 cue。`count` 是本帧合并进它的事件数——**抬高增益，绝不把 cue 播两遍**。
   */
  play(cue: AudioCue, count = 1): void {
    const def = CUE_CATALOGUE[cue];
    const scale = def.gain * coalesceBoost(count);
    const variants = this.deps.bank.variantsOf(cue);
    if (!variants || variants.length === 0) {
      this.playSynth(cue, scale);
      return;
    }

    const buffer = this.pickVariant(cue, variants);
    const rate = 1 + (this.random() * 2 - 1) * PITCH_JITTER;
    const { ctx, bus } = this.deps;
    const now = ctx.currentTime;

    // 在建任何节点**之前**申请槽位，于是被丢掉的 cue 一分钱不花。`voice` 在下面填上，且只被
    // 抢占者读——而抢占只可能来自**更晚**的一次 claim，绝不会在本次调用返回前发生。
    let voice: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
    const claimed = this.budget.claim(def.priority, now, now + buffer.duration / rate, () => {
      if (voice) this.steal(voice.src, voice.gain);
    });
    if (!claimed) return;

    const gain = ctx.createGain();
    gain.gain.value = scale;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // 加了保护：`playbackRate` 是标准 WebAudio，但同一份代码将来也要跑在微信侧的上下文上，
    // 那边的节点表面只有文档、没有本仓库能做的验证——缺一个参数应当损失抖动，而不是损失声音。
    if (src.playbackRate) src.playbackRate.value = rate;
    src.connect(gain).connect(bus);
    voice = { src, gain };
    src.start(now);
  }

  private playSynth(cue: AudioCue, scale: number): void {
    const { ctx, bus } = this.deps;
    // 恰好等于 1.0 时那个修正节点是可证明的空操作，于是合成音直连总线。
    if (scale === 1) {
      playCue(cue, ctx, bus);
      return;
    }
    const trim = ctx.createGain();
    trim.gain.value = scale;
    trim.connect(bus);
    playCue(cue, ctx, trim);
  }

  /** 一个绝不等于该 cue 上次播过的 variant 下标。 */
  private pickVariant(cue: AudioCue, variants: readonly AudioBuffer[]): AudioBuffer {
    const n = variants.length;
    const last = this.lastVariant.get(cue);
    let i: number;
    if (n === 1 || last === undefined) {
      i = Math.min(n - 1, Math.floor(this.random() * n));
    } else {
      // 从**另外** n-1 个里抽，再跨过被排除的那个槽位。
      const k = Math.min(n - 2, Math.floor(this.random() * (n - 1)));
      i = k < last ? k : k + 1;
    }
    this.lastVariant.set(cue, i);
    return variants[i]!;
  }

  private steal(src: AudioBufferSourceNode, gain: GainNode): void {
    const t = this.deps.ctx.currentTime;
    try {
      gain.gain.setValueAtTime(gain.gain.value, t);
      gain.gain.linearRampToValueAtTime(0, t + STEAL_FADE);
      src.stop(t + STEAL_FADE);
    } catch {
      // 在清扫和这里之间它已经自己播完了——没有什么需要掐短。
    }
  }
}
