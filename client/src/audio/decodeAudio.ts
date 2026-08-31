// 一个 promise 形状的 `decodeAudioData`，盖住两个运行时对它形状的分歧。
//
// 浏览器的 WebAudio `decodeAudioData` **返回** promise（同时仍然接受老式的 success/error 回调）。
// 微信小游戏侧（AUDIO_DESIGN.md §3 规划的 `InnerAudioContext` 之外，若某个基础库版本提供
// WebAudio 形状的上下文）是回调形式，而"从哪个基础库版本开始返回 promise"不是本仓库能钉住的。
// 假定任何一种形状，都会让另一个目标**静默地**什么都加载不上、永远退回合成音——那正是这条
// 管线要终结的失效模式，而且它看起来和"一切正常"一模一样。
//
// 所以：回调和返回值**同时**接受，谁先到算谁；同步抛出也归一成 rejection。
//
// 这个文件是从 daydayup 逐字移植过来的（那边同一个问题、同一个解法），只翻译了注释。

/**
 * 只需要这一个方法——结构化声明，于是真的 `AudioContext`、小游戏的 WebAudio 上下文、
 * 以及测试替身都能满足。返回类型刻意比 DOM lib 的 `Promise<AudioBuffer>` 宽：回调形状的实现
 * 可能什么都不返回。
 */
export interface AudioDecoder {
  decodeAudioData(
    data: ArrayBuffer,
    success?: (buffer: AudioBuffer) => void,
    error?: (err: unknown) => void,
  ): Promise<AudioBuffer> | undefined | void;
}

export function decodeAudio(ctx: AudioDecoder, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    // 两种形状可能都触发，而且 promise 实现也可能**顺带**调用回调。Promise 语义本身就会忽略
    // 第二次 settle，这个标志只是把"忽略"写明，而不是让它成为一个偶然属性。
    let settled = false;
    const ok = (buffer: AudioBuffer): void => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err ?? 'decodeAudioData failed')));
    };

    let returned: Promise<AudioBuffer> | undefined | void;
    try {
      returned = ctx.decodeAudioData(data, ok, fail);
    } catch (err) {
      // 干脆拒绝回调形式的运行时会在这里抛出，而不是调 `error`——把它当成本文件的一次失败，
      // 而不是一次未捕获的启动异常。
      fail(err);
      return;
    }
    if (returned && typeof (returned as Promise<AudioBuffer>).then === 'function') {
      (returned as Promise<AudioBuffer>).then(ok, fail);
    }
  });
}
