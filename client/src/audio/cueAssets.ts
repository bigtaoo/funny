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
// `sfx-unit-hit_02.mp3`。约定只服务于人和未来的处理脚本，不参与解析——URL 由上面的 import 决定。
import type { AudioCue } from './types';

/**
 * 每个 cue 的样本 variant URL，按 variant 顺序。**没有条目 = 该 cue 只有合成音。**
 *
 * 为什么现在是空的：`art/` 下还没有任何音频资产。AUDIO_DESIGN.md §1 要的是「文具拟音」
 * （铅笔沙沙、橡皮擦、翻页、笔帽咔哒），并明确**禁止**金属碰撞与爆炸轰鸣——现成的 CC0 游戏
 * 音效包（Kenney 那六个：激光/金属撞击/玻璃碎/爆炸）正好整个落在禁用清单里，UI 那一小撮之外
 * 没有能直接拿来用的。所以素材要么自录、要么从 freesound.org 的 CC0 拟音里挑，是独立的一步。
 *
 * 在那之前这个映射保持为空，`CueMixer` 走合成音那一级——**这不是占位实现，是设计好的第二级**
 * （见 `CueMixer` 顶部注释）。素材到位后在这里加一行 import + 一个条目，`variantCount` 会自动
 * 反映出来，其余代码一行不用改。
 *
 * 多余的 key 会被类型系统挡住（`Partial<Record<AudioCue, …>>`），拼错的 cue id 是编译错误。
 */
export const CUE_ASSETS: Partial<Record<AudioCue, readonly string[]>> = {
  // 示例（素材到位后照此形式填，删掉本注释）：
  //   import tap00 from '../assets/audio/sfx-ui-tap_00.mp3';
  //   'sfx.ui.tap': [tap00],
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
