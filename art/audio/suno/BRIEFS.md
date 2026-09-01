# BGM 生成 brief（Suno）— `bgm.lobby` / `bgm.battle`

> AUDIO_DESIGN.md §7 第 7 步。两轨，来源经 2026-09-01 拍板走 **Suno 生成**——理由不是「找不到 CC0
> 音乐」，是 CC0 音乐池几乎全是 chiptune，与「手绘笔记本」的调性直接冲突（daydayup 的同一处实测结论）。
>
> **这份 brief 本身是发货记录的一部分。** daydayup 那轮把 master 生成完之后 prompt 原文没留下来，
> 它的 `credits.json` 里因此有两条 `prompt_note` 写着「记录成开放缺口而不是事后重构一个像记录的猜测」。
> 本轮不重犯：下面的 prompt 原文进 `credits.json` 的 `music[].prompt`。

## 共同约束（两轨都成立，理由在括号里）

| 约束 | 为什么 |
|---|---|
| **纯器乐**（Suno 的 Instrumental 开关必须打开） | 人声在游戏底噪里是最抢注意力的东西，也是 AI 音乐侵权风险最集中的地方 |
| **没有 build / drop / riser / outro**，一个乐句从头稳到尾 | 我们要从 master 里切一段 **20–90 秒**的循环区，靠交叉淡入闭环。有编曲弧线的段落切出来会在接缝处「回到前面」 |
| **中频（250–2000 Hz）留白** | 全部 18 个 cue 的峰值就住在这个带里。铺满中频的衬垫会让出牌声、受击声读不出来——`audit.py` 的 `music` 门禁直接量这个带（目标 −31…−29 dBFS） |
| **不要 sub-bass / 808 / 低频 drone** | daydayup 第一次生成回来就是一条 sub-bass drone，20–250 Hz 比其它带高 13 dB：手机喇叭上完全听不见、耳机上又是唯一听得见的东西，还白占 MP3 码率。最后要靠一道 80 Hz / −14 dB 的 shelf 救 |
| **电平不用管** | AI master 一律在 ~0 dBFS，而我们的 cue 集峰值在 −14…−23 dBFS，每个 master 都要衰减 13–15 dB。这是管线的事，你只管好不好听 |

## 轨一 `bgm.lobby` — 大厅 / 菜单 / 商店 / 世界地图 / 首启故事

**意象**：上课走神时在笔记本边角上画画的那个下午。轻快、好奇、有点顽皮，**不推动情绪**——它是背景，不是配乐。

**Style prompt（直接粘）**：

```
warm hand-drawn notebook doodle bed, sparse and unhurried; nylon-string guitar plucks, celesta and music box, kalimba, dry wooden pencil-tap ticks, soft felt upright piano; 88 BPM, one repeating phrase, playful and curious, low presence, sits behind the game; steady throughout, no arrangement changes
```

**Exclude styles（直接粘）**：

```
vocals, drum kit, kick, snare, sub-bass, 808, synth bass, chiptune, 8-bit, orchestra, strings section, brass, choir, distorted guitar, EDM, supersaw, big reverb pad, build, drop, riser, cinematic swell, outro
```

## 轨二 `bgm.battle` — 对战 / 战役关卡内

**意象**：课桌底下偷偷进行的一场战争。有推进感、有紧张，但**始终是玩笑**——不悲壮、不英雄化，配得上「叛逆少年 / 红笔假想敌」这个设定。

**Style prompt（直接粘）**：

```
mischievous notebook-war march, tense but never epic; staccato pizzicato strings, muted upright bass plucks, shaker and woodblock, short repeating ostinato, occasional music-box accent; 118 BPM, driving but light, dry and close, leaves the midrange open; steady throughout, no arrangement changes
```

**Exclude styles（直接粘）**：

```
vocals, epic trailer drums, taiko, cymbal crash, brass fanfare, choir, orchestral hits, distorted guitar, metal, chiptune, 8-bit, sub-bass drone, 808, EDM, build, drop, riser, breakdown, outro
```

## 交回来的时候

1. **每轨生成 2–3 个候选，全都给我**，不要自己先筛。挑选是一次**测量**——`audit.py --class music` 会
   扫遍整个 master 找最好的循环区，报 `xfade_band_diff`（接缝处头尾的音色差）和各频带 RMS。daydayup
   那轮「生成出来的东西和 brief 完全不是一回事」发生过一次（menu 的 brief 生成出一条 drone），最后
   是**改派**而不是重生成——候选多一个，这种事就从损失变成收获。
2. 能导 **WAV** 就导 WAV（管线要做 shelf 和衰减，从有损源再编码一次是白丢一次质量）；不能就导最高档 MP3。
3. 放到 `D:\funny\art\audio\suno\`，文件名保持 Suno 给的标题。
4. **把最终用的 prompt 原文贴回来**（或存成同名 `.txt`）——包括你临场改过的部分。这一条是上面说的那个
   记录缺口，只有你手里有。
