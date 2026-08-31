// 程序化合成音：每个 cue 一把「声音」，零资产、零授权。
//
// 它**不是占位实现，是 `CueMixer` 决策阶梯上永久的第二级**。素材到位后仍然有四种情况落在这里：
// 冷启动时预载还没解析完、某个文件拉取/解码失败、某个 cue 决定不配样本、以及现在这个阶段
// （`cueAssets.ts` 还是空的）。这一级的存在把「没有音频资产」从**静音**变成了「有声但不同」，
// 后者可测、可听、可验收；前者和「音频坏了」完全无法区分。
//
// 音色方向服从 AUDIO_DESIGN.md §1 / art-direction §声音：**文具拟音**——铅笔沙沙、橡皮擦吱、
// 翻页、纸团揉碎、笔帽咔哒。**不做**金属碰撞和爆炸轰鸣。这条约束直接决定了下面的实现形状：
// 纸质声音的能量几乎全在**滤波噪声**里（而不是振荡器音高），而揉纸和翻页本质是**多颗粒**的，
// 所以两个原语都带 `delay`——这是本文件比"一个 tone() 加一个 noise()"多出来的两个旋钮的由来。
//
// 确定性（AUDIO_DESIGN.md §6）：`noise()` 用 `Math.random()` 生成噪声缓冲——这是**渲染侧**
// 随机，与 `@nw/engine` 的 `Prng` 无关，也绝不允许反向影响它。
import type { AudioCue } from './types';

/** 一个带音高的音。`slideTo` 给出线性滑音终点，`delay` 把它推后到 cue 起点之后。 */
export interface ToneSpec {
  freq: number;
  type: OscillatorType;
  dur: number;
  /** 线性峰值增益。因为包络是 0 → gain → 0，这个值**就是**该音的峰值（素材峰值对齐时要用）。 */
  gain: number;
  slideTo?: number;
  delay?: number;
}

/** 噪声颗粒的包络形状：`decay` = 敲击/刮擦（起手即最响），`swell` = 翻页/纸张摩擦（涨起再落）。 */
export type NoiseShape = 'decay' | 'swell';

/** 一颗滤波噪声。纸质音效的主要成分。 */
export interface NoiseSpec {
  dur: number;
  /** 线性峰值增益；噪声样本被限制在 ±1，所以这个值同样就是峰值。 */
  gain: number;
  /** 低通截止（Hz）。纸/铅笔的"软"来自这里。 */
  cutoff?: number;
  /** 低通截止的线性滑动终点——翻页那种"由闷到亮"的扫频。 */
  cutoffTo?: number;
  /** 高通截止（Hz）。纸张没有低频内容，砍掉它是"像纸"和"像闷响"的分界。 */
  hp?: number;
  shape?: NoiseShape;
  delay?: number;
}

export function tone(ctx: AudioContext, bus: GainNode, spec: ToneSpec): void {
  const t = ctx.currentTime + (spec.delay ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = spec.type;
  osc.frequency.setValueAtTime(spec.freq, t);
  if (spec.slideTo !== undefined) osc.frequency.linearRampToValueAtTime(spec.slideTo, t + spec.dur);
  // 快起手 + 线性衰减到 ~0。5ms 的起手是为了避免包络本身产生咔哒声。
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(spec.gain, t + 0.005);
  g.gain.linearRampToValueAtTime(0, t + spec.dur);
  osc.connect(g).connect(bus);
  osc.start(t);
  osc.stop(t + spec.dur + 0.02);
}

export function noise(ctx: AudioContext, bus: GainNode, spec: NoiseSpec): void {
  const t = ctx.currentTime + (spec.delay ?? 0);
  const n = Math.max(1, Math.floor(ctx.sampleRate * spec.dur));
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const swell = spec.shape === 'swell';
  for (let i = 0; i < n; i++) {
    // 包络烘进缓冲而不是用 GainNode：一颗噪声只播一次，省两个自动化节点；`swell` 用半个正弦
    // 得到平滑的涨落，正是一次翻页的形状。
    const env = swell ? Math.sin((Math.PI * i) / n) : 1 - i / n;
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const cutoff = spec.cutoff ?? 3000;
  lp.frequency.setValueAtTime(cutoff, t);
  if (spec.cutoffTo !== undefined) lp.frequency.linearRampToValueAtTime(spec.cutoffTo, t + spec.dur);

  const g = ctx.createGain();
  g.gain.value = spec.gain;

  if (spec.hp !== undefined) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = spec.hp;
    src.connect(hp).connect(lp).connect(g).connect(bus);
  } else {
    src.connect(lp).connect(g).connect(bus);
  }
  src.start(t);
  src.stop(t + spec.dur + 0.02);
}

// 每个 cue 一把声音。整体压得很轻——战斗每帧能吐出一大把事件，而且调用方已经把同帧重复的
// cue 合并掉了（AUDIO_DESIGN.md §4）。
//
// 三条贯穿整张表的取舍：
//  * **发射越频繁，越短越轻。** `sfx.unit.attack` 是 35ms / 0.11，`sfx.base.hit` 是 160ms / 0.14。
//  * **UI 那几个高频 cue 各自只用一个原语**（tap/back/error），于是它们的峰值就是 `gain` 参数、
//    不需要重新渲染测量——将来给样本做峰值对齐时省掉一整个步骤。reward/揭示是刻意的例外：
//    「奖励」需要两三个音才读得出上扬，那是它的语义。
//  * **UI 全部坐在 0.08–0.10**，低于每一个战斗音。按钮要在安静的菜单里听得见，绝不能在混战里
//    盖过战斗。
const VOICES: Record<AudioCue, (ctx: AudioContext, bus: GainNode) => void> = {
  // 笔尖落纸"唰"：一次刮擦 + 一记极轻的落笔接触。
  'sfx.card.play': (c, b) => {
    noise(c, b, { dur: 0.09, gain: 0.16, hp: 1200, cutoff: 7000, cutoffTo: 4000 });
    tone(c, b, { freq: 150, type: 'triangle', dur: 0.04, gain: 0.05 });
  },
  // 橡皮擦短"吱"：下滑的锯齿（吱声的音高成分）+ 明亮噪声（橡胶摩擦）。
  'sfx.card.invalid': (c, b) => {
    tone(c, b, { freq: 640, type: 'sawtooth', dur: 0.11, gain: 0.10, slideTo: 500 });
    noise(c, b, { dur: 0.11, gain: 0.07, hp: 2000, cutoff: 8000 });
  },
  // 铅笔短戳：全表最短最轻的一个点。全局发射频率最高，密度比音色重要。
  'sfx.unit.attack': (c, b) => noise(c, b, { dur: 0.035, gain: 0.11, hp: 900, cutoff: 4500 }),
  // 软"噗"/揉纸：闷的噪声 + 一记下滑的低频身体。
  //
  // 截止频率 2400 而不是最初写的 1400（2026-08-31，真浏览器实测后改）：**授权峰值不等于交付
  // 峰值**——`gain` 是滤波器之前的振幅，而白噪声被 1400 Hz 低通砍掉后真正送到总线的峰值只剩
  // 0.063，与本该是全表最轻的 `sfx.unit.attack`（0.065，只过 900 Hz 高通 + 4500 低通，损失小得
  // 多）齐平，正好和 catalogue 里"受击(0.9/60) 明显高于攻击(0.7/20)"的意图相反。单元测试量的是
  // 授权峰值（节点图上的 gain），看不到这一层；只有在真 `AudioContext` 上接一个 AnalyserNode 才
  // 量得出来。抬截止而不是抬 gain，是为了不越过 0.2 的授权峰值上限——那条上限管的是合并增益
  // （最高 ×1.5）叠上来之后会不会削波，放宽它才是真的有风险。2400 Hz 对"软噗"仍然够闷。
  'sfx.unit.hit': (c, b) => {
    noise(c, b, { dur: 0.075, gain: 0.17, cutoff: 2400 });
    tone(c, b, { freq: 190, type: 'triangle', dur: 0.05, gain: 0.06, slideTo: 140 });
  },
  // 厚本子闷响：唯一一个允许有真低频的战斗音——它是输赢信号。
  'sfx.base.hit': (c, b) => {
    tone(c, b, { freq: 110, type: 'sine', dur: 0.16, gain: 0.14, slideTo: 80 });
    noise(c, b, { dur: 0.11, gain: 0.12, cutoff: 700 });
  },
  // 翻页 + 落石涂抹：先一次 swell 扫频（书页翻过去），再一片闷的涂抹声压在后半。
  'sfx.spell.cast': (c, b) => {
    noise(c, b, { dur: 0.22, gain: 0.13, hp: 1500, cutoff: 3000, cutoffTo: 9000, shape: 'swell' });
    noise(c, b, { dur: 0.18, gain: 0.10, cutoff: 900, delay: 0.14 });
  },
  // 纸团揉碎：四颗错开的颗粒，逐渐变轻——揉纸本质是多颗粒的，一颗噪声只会像"噗"。
  'sfx.unit.death': (c, b) => {
    noise(c, b, { dur: 0.06, gain: 0.13, hp: 1000, cutoff: 6000 });
    noise(c, b, { dur: 0.05, gain: 0.11, hp: 1200, cutoff: 6500, delay: 0.045 });
    noise(c, b, { dur: 0.07, gain: 0.09, hp: 900,  cutoff: 5000, delay: 0.085 });
    noise(c, b, { dur: 0.05, gain: 0.07, hp: 1400, cutoff: 7000, delay: 0.13 });
  },
  // 水滴"嘀"：上滑的正弦——滴落声的听感来自音高上扬，不是下降。
  'sfx.ink.tick': (c, b) => tone(c, b, { freq: 900, type: 'sine', dur: 0.07, gain: 0.07, slideTo: 1500 }),

  // 结算：三音上行 / 二音下行。刻意只用 triangle——它最接近木质/纸质的柔和泛音，
  // sawtooth 那种锐利感属于被禁用的写实战争调性。
  'sfx.result.victory': (c, b) => {
    tone(c, b, { freq: 523, type: 'triangle', dur: 0.16, gain: 0.13 });
    tone(c, b, { freq: 659, type: 'triangle', dur: 0.16, gain: 0.12, delay: 0.09 });
    tone(c, b, { freq: 784, type: 'triangle', dur: 0.26, gain: 0.12, delay: 0.18 });
  },
  'sfx.result.defeat': (c, b) => {
    tone(c, b, { freq: 392, type: 'triangle', dur: 0.18, gain: 0.12 });
    tone(c, b, { freq: 294, type: 'triangle', dur: 0.30, gain: 0.12, delay: 0.12, slideTo: 262 });
  },

  // ── UI ───────────────────────────────────────────────────────────────────
  // 笔帽咔哒：一颗极短的明亮颗粒。
  'sfx.ui.tap': (c, b) => noise(c, b, { dur: 0.025, gain: 0.10, hp: 2600, cutoff: 9000 }),
  // 四个 UI 音里音高最低的一个，且向下滑：离开一个界面听起来必须比进入它更低。
  'sfx.ui.back': (c, b) => tone(c, b, { freq: 620, type: 'square', dur: 0.055, gain: 0.09, slideTo: 430 }),
  'sfx.ui.reward': (c, b) => {
    tone(c, b, { freq: 784, type: 'triangle', dur: 0.10, gain: 0.10 });
    tone(c, b, { freq: 1046, type: 'triangle', dur: 0.14, gain: 0.09, delay: 0.07 });
  },
  // 揭示三档：音数递增 + 亮度递增，所以"史诗"在听到第三个音之前就已经和"普通"分开了。
  'sfx.ui.gacha.reveal.common': (c, b) => tone(c, b, { freq: 660, type: 'triangle', dur: 0.11, gain: 0.09 }),
  'sfx.ui.gacha.reveal.rare': (c, b) => {
    tone(c, b, { freq: 660, type: 'triangle', dur: 0.10, gain: 0.09 });
    tone(c, b, { freq: 880, type: 'triangle', dur: 0.14, gain: 0.09, delay: 0.08 });
  },
  'sfx.ui.gacha.reveal.epic': (c, b) => {
    tone(c, b, { freq: 660,  type: 'triangle', dur: 0.10, gain: 0.09 });
    tone(c, b, { freq: 880,  type: 'triangle', dur: 0.10, gain: 0.09, delay: 0.08 });
    tone(c, b, { freq: 1174, type: 'triangle', dur: 0.22, gain: 0.10, delay: 0.16 });
    noise(c, b, { dur: 0.20, gain: 0.05, hp: 5000, cutoff: 12000, shape: 'swell', delay: 0.16 });
  },
  // 持续的低频嗡音，不是咔哒。它和 `sfx.ui.tap` 的区别靠**长度和密度**，不靠音高——
  // 两者都是对同一次按下的回答，音高差异不足以让人分辨"按到了"和"这下没用"。
  'sfx.ui.error': (c, b) => tone(c, b, { freq: 300, type: 'sawtooth', dur: 0.19, gain: 0.10, slideTo: 240 }),
};

/** 播放一个 cue 的合成音。`CueMixer` 在没有可用样本时唯一的出口。 */
export function playCue(cue: AudioCue, ctx: AudioContext, bus: GainNode): void {
  VOICES[cue](ctx, bus);
}

/** 该 cue 是否有合成音。穷尽的 `Record` 保证恒为真——留给测试做穷尽性断言。 */
export function hasVoice(cue: AudioCue): boolean {
  return typeof VOICES[cue] === 'function';
}
