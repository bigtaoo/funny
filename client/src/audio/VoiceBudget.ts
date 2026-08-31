// 并发上限（AUDIO_DESIGN.md §5 "同时音频实例数有限 … 超量丢弃"）。
//
// 纯记账——"现在有几个声道在响，哪个最该被牺牲"——不碰任何 WebAudio 类型，所以可以用普通数字
// 做单元测试。
//
// **对 AUDIO_DESIGN.md §5 的一处改判**：那里写的是"超量丢弃最旧"。这里改成**按优先级抢占**：
// 最旧不一定最不重要——一局里最旧的那个声道很可能正是 600ms 的结算 stinger，而新来的是第 40 个
// `sfx.unit.attack`。丢最旧会把唯一那次胜利音砍掉，换来一个听不出区别的攻击音。
//
// 声道按**时间**退休，不靠 `ended` 事件。每次申请都声明自己什么时候放完，下一次申请负责清扫
// 已经过期的。这是刻意的：`onended` 在浏览器里有，但在本仓库钉不住版本的微信基础库上是又一件
// 要验证的事，而一个"悄悄停止清扫"的上限会**失效于静默**——前 N 个 cue 之后混音直接变哑，
// 看起来就是"音频坏了"。一段音的长度在它开始之前就已知，所以这里除了时钟什么都不需要。

interface LiveVoice {
  priority: number;
  /** 该声道不再可闻的上下文时间（秒）。 */
  until: number;
  /** 被更高优先级抢占时把它掐短。 */
  stop(): void;
}

export class VoiceBudget {
  private readonly live: LiveVoice[] = [];

  /** @param cap 同时可响的样本声道数上限。 */
  constructor(private readonly cap: number) {}

  /**
   * 为一个优先级 `priority`、在 `until` 放完的声道，在 `now` 申请一个槽位。
   *
   * 上限已满且该 cue **不高于**仍在播的最弱声道时返回 false，调用方于是什么都不播。
   * 同优先级判输是刻意的：撞满上限时，已经在响的那个 `sfx.unit.attack` 和下一个一样值钱，
   * 抢占它只会多一声咔哒。新来者确实更高时，最弱的那个被停掉（同优先级里停最旧的），槽位交接。
   */
  claim(priority: number, now: number, until: number, stop: () => void): boolean {
    this.purge(now);
    if (this.live.length >= this.cap) {
      // cap 为 0 时没有任何东西可抢——拒绝，而不是去索引一个空列表。
      if (this.live.length === 0) return false;
      let weakest = 0;
      for (let i = 1; i < this.live.length; i++) {
        if (this.live[i]!.priority < this.live[weakest]!.priority) weakest = i;
      }
      if (this.live[weakest]!.priority >= priority) return false;
      this.live[weakest]!.stop();
      this.live.splice(weakest, 1);
    }
    this.live.push({ priority, until, stop });
    return true;
  }

  private purge(now: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (this.live[i]!.until <= now) this.live.splice(i, 1);
    }
  }

  /** 当前持有的声道数，**不先清扫**（想问"某一刻有几个"的调用方把那一刻传给 `claim`）。 */
  get held(): number {
    return this.live.length;
  }
}
