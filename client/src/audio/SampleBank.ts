// 加载路径：cue id 进，解码好的 PCM 出（AUDIO_DESIGN.md §5 "解码开销 … preload"）。
//
// 走的是**和美术完全相同的平台接缝**：`assets/assetIO.ts` 的 `loadBinary`——web/CrazyGames 是
// `fetch`，微信是 `wx.downloadFile` + 本地缓存（ASSET_PACKAGING §4）。于是音频免费继承整套
// 分包/CDN 规则：URL 由 webpack 在构建期烘焙（见 `cueAssets.ts`），这里不拼、不猜、不重写路径。
//
// 每个文件**各自**尽力而为，同美术预载的规矩（`assets/bootManifest.ts` 的 `preloadBoot` 从不
// reject）——但有一处差别值得说明：缺一张贴图留下的是占位圆圈，缺一个样本留下的是合成音，
// 后者的降级成本低得多，所以这里更没有理由抛出。
import type { AudioCue } from './types';
import { cuesWithSamples } from './cueCatalogue';
import { variantUrls } from './cueAssets';
import { decodeAudio, type AudioDecoder } from './decodeAudio';

export interface SampleBankDeps {
  /**
   * 把压缩字节解成 PCM。真实的 `AudioContext` 在**仍处于 suspended** 状态下也能正常解码，
   * 这正是启动预载不必等 autoplay 手势的原因（AUDIO_DESIGN.md §5）。
   */
  ctx: AudioDecoder;
  /** 平台字节读取——生产代码传 `assets/assetIO.ts` 的 `assetIO().loadBinary`。 */
  readBinary(url: string): Promise<ArrayBuffer>;
  /** 单文件失败往哪里报。默认 `console.warn`；测试传自己的。 */
  warn?(message: string, err: unknown): void;
}

export class SampleBank {
  /**
   * 每个 cue 解好的 variant，按 variant 顺序。一个 cue 在它至少有一个文件解码成功之前是
   * **缺席**的——`CueMixer` 把缺席读作"用合成音"。
   */
  private readonly buffers = new Map<AudioCue, AudioBuffer[]>();
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: SampleBankDeps) {}

  /**
   * 拉取 + 解码全部已登记样本。可以调用多次：第二次只重试**什么都没加载上**的 cue（部分或
   * 全部失败，例如启动时断网）；在一次加载还没结束时调用则并入那一次，而不是把请求翻倍。
   */
  load(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const pending = cuesWithSamples().filter((cue) => !this.buffers.has(cue));
    this.inFlight = Promise.all(pending.map((cue) => this.loadCue(cue)))
      .then(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async loadCue(cue: AudioCue): Promise<void> {
    const decoded = await Promise.all(
      variantUrls(cue).map(async (url) => {
        try {
          return await decodeAudio(this.deps.ctx, await this.deps.readBinary(url));
        } catch (err) {
          this.warn(`audio: ${url} 加载失败——该 variant 退回合成音`, err);
          return null;
        }
      }),
    );
    // variant **顺序**保住了（`Promise.all` 保序），失败的那个只是不在里面——所以 5 个文件成功 3 个的
    // cue 仍然有三路变化可用，而不是整个 cue 归零。
    const usable = decoded.filter((b): b is AudioBuffer => b !== null);
    if (usable.length > 0) this.buffers.set(cue, usable);
  }

  private warn(message: string, err: unknown): void {
    if (this.deps.warn) this.deps.warn(message, err);
    else console.warn(message, err);
  }

  /** 该 cue 解好的 variant；没有时返回 undefined（只有合成音、还没加载、或全部失败）。 */
  variantsOf(cue: AudioCue): readonly AudioBuffer[] | undefined {
    return this.buffers.get(cue);
  }

  /** 当前至少有一个样本可用的 cue 数——"已发货的那套到底响不响"的诚实答案，启动日志用它。 */
  get loadedCues(): number {
    return this.buffers.size;
  }

  /** 跨全部 cue 解好的 variant 总数。 */
  get loadedVariants(): number {
    let n = 0;
    for (const list of this.buffers.values()) n += list.length;
    return n;
  }
}
