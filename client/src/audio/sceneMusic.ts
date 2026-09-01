// 场景 → BGM 轨的**单一映射表**（AUDIO_DESIGN.md §2.3）。
//
// 同 `EventsPanel.collectCue` 之于战斗 cue：全游戏只有这一处回答"这个界面该放什么音乐"，
// 由 `SceneManager` 在每次 swap / pushOverlay / popOverlay 之后调一次。场景自己不碰音频——
// 40 个场景各自记得在 `destroy()` 里停音乐，是一份注定会漏的重复。
//
// ── 为什么是「默认放，列出不放的」而不是「列出要放的」──────────────────────────────────
//
// AUDIO_DESIGN §0 记着 UI 触发点那一步的教训：连着两遍"按已知的机制去数"，两遍都漏掉一整族
// 按钮，而漏掉的症状是**安静**——所有测试全绿，只有人坐下来玩才会发现。白名单在这里会重演同一
// 件事：新加一个场景，忘了登记，它就是静音的，而静音和"这个场景本来就该安静"无法区分。
//
// 反过来的失效模式明显得多：一个本该安静的新场景如果忘了登记，玩家会**听见**大厅音乐盖在它上面。
// 两种错误都会发生，但只有一种会被人发现，所以默认值取在那一边。
import type { MusicTrack } from './types';

/**
 * 不放音乐的场景，按类名。
 *
 * 只有一条判据：**这里有别的东西在负责声音**。三个都是对局画面——战斗音效是它们的声音，
 * 一条大厅床垫铺在下面既抢了 `sfx.base.hit` 的位置，也和 §2.3 给 `bgm.battle` 留的位置冲突
 * （那条轨还不存在，见 `musicTracks.ts`；在它到来之前，对局的正确答案是安静而不是凑合）。
 *
 * 类名而不是 `instanceof`：`SceneManager` 手上只有 `Scene` 接口和构造函数名，而 webpack 的
 * terser 配置正是为此保留了 `/Scene$/` 的类名（`keep_classnames`，同 `anr.scene` 面包屑）。
 * 拼错一个名字在这里是**静默**失效，所以 `sceneMusic.test.ts` 拿 `src/scenes/` 的真实类名对表。
 */
export const SILENT_SCENES: readonly string[] = [
  'GameScene',        // 对局
  'ReplayScene',      // 回放同一场对局，声音走的是同一条战斗管线
  'StatePlayerScene', // 状态回放/排障，同上
];

/** 除上表之外的一切界面（大厅、菜单、商店、世界地图、结算、首启故事…）。 */
export const DEFAULT_SCENE_TRACK: MusicTrack = 'bgm.lobby';

/** 这个场景类名该放哪条轨；`null` = 应该安静。 */
export function musicForScene(sceneName: string): MusicTrack | null {
  return SILENT_SCENES.includes(sceneName) ? null : DEFAULT_SCENE_TRACK;
}
