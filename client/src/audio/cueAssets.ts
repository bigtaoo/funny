// cue id → 已发货音频文件 URL。**本仓库唯一持有音频 `import` 语句的文件。**
//
// 为什么是显式 import 而不是拼路径字符串（这是与 daydayup 那套实现最大的一处改判）：
// funny 的资源 URL 在**构建期**由 webpack 烘焙（`asset/resource`，见 ASSET_PACKAGING §4）——
// `import u from './x.mp3'` 得到的是 `<CDN>/cdn/<hash>.mp3` 绝对 URL。字面量 `'/audio/x.mp3'`
// 不会被重写，于是在微信（无 fetch、资源全在 CDN 上）和任何设了 `NW_ASSET_CDN` 的 web 构建里
// 都是 404。所以「按 cue id + variant 数拼出路径」这条捷径在这里根本不成立。
//
// 换来的好处比失去的多：一个写错/删掉的文件名是**构建失败**，而不是运行时静默地退回合成音
// （后者与「这个 cue 本来就没有样本」完全无法区分）。因此这里不需要任何「生成的路径集合 vs
// 磁盘实际文件」的一致性测试——webpack 就是那个测试。
//
// 资源放在 `client/src/assets/audio/`（与 `assets/units/`、`assets/buildings/` 同级；
// webpack 的 `asset/resource` 规则已经涵盖 `mp3|wav|ogg`，无需改配置）。
//
// 命名约定：`<cue id 里的 '.' 换成 '-'>_NN.<ext>`，例如 `sfx.unit.hit` 的第 3 个 variant 是
// `sfx-unit-hit_02.mp3`。约定只服务于人和处理脚本（`tools/audio-pipeline/process.py` 按它写出
// 文件名，`audit.py` 按它反查该文件受哪个门禁约束），不参与解析——URL 由下面的 import 决定。
import type { AudioCue } from './types';

// ── 战斗内 ──────────────────────────────────────────────────────────────────
import cardPlay00 from '../assets/audio/sfx-card-play_00.mp3';
import cardPlay01 from '../assets/audio/sfx-card-play_01.mp3';
import cardPlay02 from '../assets/audio/sfx-card-play_02.mp3';
import cardInvalid00 from '../assets/audio/sfx-card-invalid_00.mp3';
import cardInvalid01 from '../assets/audio/sfx-card-invalid_01.mp3';
import cardInvalid02 from '../assets/audio/sfx-card-invalid_02.mp3';
import unitAttack00 from '../assets/audio/sfx-unit-attack_00.mp3';
import unitAttack01 from '../assets/audio/sfx-unit-attack_01.mp3';
import unitHit00 from '../assets/audio/sfx-unit-hit_00.mp3';
import unitHit01 from '../assets/audio/sfx-unit-hit_01.mp3';
import unitHit02 from '../assets/audio/sfx-unit-hit_02.mp3';
import baseHit00 from '../assets/audio/sfx-base-hit_00.mp3';
import spellCast00 from '../assets/audio/sfx-spell-cast_00.mp3';
import spellCast01 from '../assets/audio/sfx-spell-cast_01.mp3';
import spellCast02 from '../assets/audio/sfx-spell-cast_02.mp3';
import unitDeath00 from '../assets/audio/sfx-unit-death_00.mp3';
import unitDeath01 from '../assets/audio/sfx-unit-death_01.mp3';
import unitDeath02 from '../assets/audio/sfx-unit-death_02.mp3';
import inkTick00 from '../assets/audio/sfx-ink-tick_00.mp3';
import inkTick01 from '../assets/audio/sfx-ink-tick_01.mp3';

// ── UI ─────────────────────────────────────────────────────────────────────
import uiTap00 from '../assets/audio/sfx-ui-tap_00.mp3';
import uiBack00 from '../assets/audio/sfx-ui-back_00.mp3';

/**
 * 每个 cue 的样本 variant URL，按 variant 顺序。**没有条目 = 该 cue 只有合成音。**
 *
 * 素材来源、每个文件的出处与逐条挑选理由在 `art/audio/credits.json`（由
 * `tools/audio-pipeline/process.py` 写出，不要手改），上游包的下载地址与 sha256 在
 * `art/audio/packs.json`。四个源全部**无需署名**即可商用（三个 CC0 + 一个 royalty-free），
 * 见 `packs.json` 的 `license` 一列。
 *
 * **10 个 cue 有样本，8 个刻意留空**（2026-09-01）。留空的那 8 个不是「还没做」——
 * `credits.json` 的 `kept_on_synth` 逐条写了理由，一句话概括：**它们的语义住在音与音的关系里，
 * 不住在音色里**。三个结算 stinger 共享同一个起始音高、靠「之后往哪走」区分胜/负/平；三档
 * 揭示是同一把声音逐档加音、加亮；`sfx.ui.reward` 是两音上行。这些关系没法靠捡三段别人的录音
 * 复现——捡回来的只会是别人的调性。实测也站在同一侧：这 8 个 cue 的运行间抖动是 0–4%，而换成
 * 样本的那 10 个是 15–48%（AUDIO_DESIGN §0.3 那张表），也就是说需要真实质感的正是后者。
 *
 * 峰值对齐：每个样本被缩放到 `实测交付峰值 / (catalogue gain × SFX 总线 0.8)`，所以**换样本
 * 不改变这个 cue 在混音里的权重**，`cueCatalogue.ts` 那张表一个数都不用动。基准是
 * AUDIO_DESIGN §0/§0.2/§0.3 三轮真浏览器实测的**交付**峰值，不是 `audioSynth.ts` 里的 `gain`
 * 参数——那两者不相等，§7 第 6 步为此已被订正过一次。
 *
 * 多余的 key 会被类型系统挡住（`Partial<Record<AudioCue, …>>`），拼错的 cue id 是编译错误。
 */
export const CUE_ASSETS: Partial<Record<AudioCue, readonly string[]>> = {
  'sfx.card.play': [cardPlay00, cardPlay01, cardPlay02],
  'sfx.card.invalid': [cardInvalid00, cardInvalid01, cardInvalid02],
  'sfx.unit.attack': [unitAttack00, unitAttack01],
  'sfx.unit.hit': [unitHit00, unitHit01, unitHit02],
  // 一个 variant，而这是测量的结论不是偷懒：整个候选池里同时满足「够低（279 Hz）」「起振够快、
  // 峰值落在 250 ms cap 之内」「零削波」的只有这一个文件。理由与被否掉的三个近似候选写在
  // credits.json 的 rationale 里。
  'sfx.base.hit': [baseHit00],
  'sfx.spell.cast': [spellCast00, spellCast01, spellCast02],
  'sfx.unit.death': [unitDeath00, unitDeath01, unitDeath02],
  'sfx.ink.tick': [inkTick00, inkTick01],
  // UI 两个各一个 variant，也是刻意的：同一个按钮每次按下答出不同的声音，读起来是「不一致」，
  // 正好与这两个 cue 要传达的「按到了 / 退出去了」相反。variant 是抗重复疲劳的手段，而按钮音
  // 的重复本身就是它的语义。
  'sfx.ui.tap': [uiTap00],
  'sfx.ui.back': [uiBack00],
};

/** 该 cue 的样本 URL 列表（无样本时为空数组，调用方读作「没东西可加载」而非错误）。 */
export function variantUrls(cue: AudioCue): readonly string[] {
  return CUE_ASSETS[cue] ?? [];
}

/** 该 cue 有几个样本 variant。0 = 只有合成音。 */
export function variantCount(cue: AudioCue): number {
  return variantUrls(cue).length;
}

/** 全部已发货样本 URL——启动预载要拉的东西。 */
export function allSfxUrls(): readonly string[] {
  return Object.values(CUE_ASSETS).flatMap((urls) => urls ?? []);
}
