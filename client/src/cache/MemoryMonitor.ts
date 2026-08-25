import * as PIXI from 'pixi.js-legacy';
import { netLog } from '../net/log';
import { reportAnomaly, setAnrContextProvider, getActiveScene } from '../net/anomaly';
import { snapshotPools } from './poolRegistry';
import { bakeStats } from '../render/bake';

// Runtime memory monitor: reads JS heap usage every few seconds, emits a console.warn when the threshold
// is exceeded, and dumps idle-object counts / rough size estimates for all object pools (poolRegistry.snapshotPools).
// On WeChat Mini Game, also hooks wx.onMemoryWarning (OS-level low-memory signal — the real budget gate).
//
// Note: performance.memory.usedJSHeapSize reflects only the **JS heap**, not GPU memory (spritesheets/textures).
// However, the major historical leaks in this game (not calling destroy on scene exit → Ticker.shared closures
// pinning the entire scene graph, growing past 10 GB across multiple games) are exactly JS-heap leaks,
// so watching usedJSHeapSize catches this class of issue precisely. Only Chromium / WeChat support performance.memory;
// other environments automatically fall back to "listen only to wx signals, skip heap sampling".
//
// The GPU side is covered separately, and by two different shapes of signal — because the 2026-08-25 crash
// showed one of them alone is not enough. genTexCount() counts generated textures (the "hundreds of
// un-destroyed Texts" leak); texBytes() sums decoded BYTES (the "three RenderTextures at 111 MB each"
// blowout, which is a count of 3 and invisible to both the count gate and the heap gate). Neither
// substitutes for the other, so both have a budget and both feed every report.

const log = netLog('mem');
const MB = 1024 * 1024;

// Default JS heap warning threshold (MB). A healthy match JS heap is typically well below 150 MB; 400 MB
// gives enough headroom to avoid false positives from normal fluctuations while still catching unbounded
// leak growth (which will eventually cross it). Can be tightened per platform via
// localStorage.setItem('nw_mem_warn_mb', '250') (e.g. low-end Android / WeChat).
const DEFAULT_WARN_MB = 400;

/**
 * Soft budget for **generated** (non-URL) base textures — Text/RenderTexture/generateTexture results
 * (see genTexCount). A healthy client keeps only a bounded live set (on-screen labels, baked chrome, a
 * handful of tokens); legitimate peaks sit in the low hundreds. Crossing this *while still climbing* is a
 * generated-texture leak caught early — before it inflates the JS heap past DEFAULT_WARN_MB (a generated
 * texture is mostly GPU memory, which usedJSHeapSize barely reflects, so this fires long before the heap
 * gate would). Tunable via localStorage.setItem('nw_gentex_budget', '400'). This is the regression guard
 * for the leak class fixed in the overlay-scene teardown pass.
 */
const DEFAULT_GEN_TEX_BUDGET = 600;

/**
 * Soft budget (MB) for **decoded texture bytes** across the whole base-texture cache.
 *
 * Why a byte budget exists alongside the count above: on 2026-08-25 a phone-class in-app WebView
 * died on a reload loop because the first lobby paint allocated three page-sized RenderTextures of
 * 111 MB each. `genTexCount` saw that as **3** — comfortably inside a budget of 600 — so nothing
 * fired, and `usedJSHeapSize` barely moved because the bytes are GPU-side. A count cannot express
 * "few but enormous"; bytes can, and it is the axis the OS actually kills on.
 *
 * 256 MB is set as "no phone should ever be here": a healthy client after the bake-resolution fix
 * sits around one screen's worth of pixels per cached page layer (~7-10 MB each on a phone).
 * Tunable via localStorage.setItem('nw_tex_budget_mb', '128').
 */
const DEFAULT_TEX_BUDGET_MB = 256;

const SAMPLE_EVERY_MS = 5_000;   // sampling interval
const REWARN_EVERY_MS = 30_000;  // minimum interval between two consecutive warnings (to avoid log spam)

interface JSHeap {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function readHeap(): JSHeap | null {
  const m = (performance as unknown as { memory?: JSHeap })?.memory;
  return m && typeof m.usedJSHeapSize === 'number' ? m : null;
}

function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

function warnThresholdMB(): number {
  try {
    const raw = globalThis.localStorage?.getItem('nw_mem_warn_mb');
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage unavailable: use default */ }
  return DEFAULT_WARN_MB;
}

function genTexBudget(): number {
  try {
    const raw = globalThis.localStorage?.getItem('nw_gentex_budget');
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage unavailable: use default */ }
  return DEFAULT_GEN_TEX_BUDGET;
}

function texBudgetMB(): number {
  try {
    const raw = globalThis.localStorage?.getItem('nw_tex_budget_mb');
    const v = raw == null ? NaN : Number(raw);
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* localStorage unavailable: use default */ }
  return DEFAULT_TEX_BUDGET_MB;
}

const round = (n: number, d = 1): number => {
  const f = 10 ** d;
  return Math.round(n * f) / f;
};

/**
 * PIXI scene-graph counters: texture cache entry count / total display objects under stage / ticker listener count.
 * These three numbers classify a "heap grows but pools are empty" pure-JS retention leak into a specific category:
 * unbounded texture cache growth vs. scene-graph remnants left un-destroyed on exit vs. ticker closure pinning
 * (see the historical leaks described at the top of this file).
 * Run only on warning (60 s cooldown); traversal is capped to avoid the counting itself worsening stutter when a leak has already occurred.
 */
const NODE_WALK_CAP = 200_000;

function countNodes(root: PIXI.Container | null): number {
  if (!root) return -1;
  let n = 0;
  const stack: PIXI.DisplayObject[] = [root];
  while (stack.length > 0 && n < NODE_WALK_CAP) {
    const obj = stack.pop() as PIXI.Container;
    n += 1;
    const kids = obj.children;
    if (kids) for (let i = 0; i < kids.length; i++) stack.push(kids[i]);
  }
  return n;
}

function cacheSize(name: 'TextureCache' | 'BaseTextureCache'): number {
  const c = (PIXI.utils as unknown as Record<string, Record<string, unknown> | undefined>)[name];
  return c ? Object.keys(c).length : -1;
}

/**
 * Collapse a BaseTextureCache key to a coarse bucket so 1000+ distinct keys aggregate into a handful of
 * categories. Art is loaded via `PIXI.Texture.from(url)` (see cardArt/gachaArt/titleArt/CardScene.drawArtFit),
 * so keys are the webpack asset URLs — bucketing by directory tells us *which* art folder is filling the cache
 * (cards vs skins vs titles vs …). data:/blob: sources bucket by scheme.
 *
 * **Generated textures** (canvas-backed `PIXI.Text`, `RenderTexture`, `generateTexture` results) have no URL —
 * PIXI keys them by an auto-incrementing uid like `pixiid_25`. Left un-collapsed, each becomes its own n=1
 * bucket and the top-N list drowns in noise while hiding the fact that they are the dominant leak class.
 * Since asset URLs always contain a '/' and generated uids never do, "no slash" ⇒ one `generated:` bucket.
 * This is the single most important distinction for this game's leaks: the URL-keyed asset cache is bounded
 * (dedup by URL) and the caching policy covers it; generated textures are freed only by an explicit
 * `destroy(true)` and are where unbounded growth actually happens (see {@link genTexCount}).
 */
function texBucket(key: string): string {
  if (key.startsWith('data:')) return 'data:';
  if (key.startsWith('blob:')) return 'blob:';
  const noQuery = key.split('?')[0];
  const slash = noQuery.lastIndexOf('/');
  if (slash < 0) return 'generated:'; // pixiid_* / canvas / RenderTexture — no URL, freed only by destroy(true)
  return noQuery.slice(0, slash);
}

/**
 * Count of **generated** (non-URL) base textures in the cache — Text/RenderTexture/generateTexture results,
 * keyed by PIXI uid (no '/'). This is the leak signal that the URL-asset cache size can't show: it should
 * stay bounded (a fixed set of live tokens/labels/baked chrome), so unbounded growth here is the smoking gun.
 */
function genTexCount(): number {
  const c = (PIXI.utils as unknown as Record<string, Record<string, unknown> | undefined>).BaseTextureCache;
  if (!c) return -1;
  let n = 0;
  for (const key of Object.keys(c)) {
    if (key.startsWith('data:') || key.startsWith('blob:')) continue;
    if (!key.includes('/')) n += 1;
  }
  return n;
}

/** Walk cap for {@link texBytes}: the base-texture cache is normally in the hundreds. */
const TEX_SCAN_CAP = 20_000;

export interface TexByteStats {
  /** Decoded bytes across the whole base-texture cache. */
  totalMB: number;
  /** Of which: **generated** (non-URL) textures — Text / RenderTexture / generateTexture results. */
  generatedMB: number;
  /** The single biggest base texture — the one line that names a "few but enormous" problem. */
  largestMB: number;
  /** Bucket (or pixi uid) of that biggest texture, plus its size in real pixels. */
  largest: string;
}

/**
 * Decoded texture bytes, not entry counts.
 *
 * {@link genTexCount} answers "how many generated textures are alive", which is the right question
 * for the leak class it was written for (hundreds of un-destroyed Texts) and the wrong one for the
 * 2026-08-25 crash: three RenderTextures of 111 MB each are a count of 3 and a third of a gigabyte.
 * `usedJSHeapSize` cannot see them either — they are GPU-side — so bytes here are the only channel
 * that would have shown it. `realWidth/realHeight` already include the texture's own resolution,
 * which is precisely the factor that was wrong.
 *
 * Exported for `test/render/textureByteAccounting.test.ts` — the rest of the module's reporting
 * surface is private, but the arithmetic here is the whole point of the change and worth pinning.
 */
export function texBytes(): TexByteStats | null {
  const c = (PIXI.utils as unknown as Record<string, Record<string, unknown> | undefined>).BaseTextureCache;
  if (!c) return null;
  let total = 0;
  let generated = 0;
  let topBytes = 0;
  let topKey = '';
  let topW = 0;
  let topH = 0;
  const keys = Object.keys(c);
  const n = Math.min(keys.length, TEX_SCAN_CAP);
  for (let i = 0; i < n; i++) {
    const k = keys[i]!;
    const bt = c[k] as unknown as { realWidth?: number; realHeight?: number } | undefined;
    const w = bt?.realWidth ?? 0;
    const h = bt?.realHeight ?? 0;
    if (!(w > 0) || !(h > 0)) continue;
    // RGBA8, base level only. Mipmapped art costs ~1/3 more (ART_TEX_OPTIONS enables mipmaps on
    // WebGL2 for downscaled portraits), but PIXI only generates them for some sources — so this
    // deliberately under-reports by a bounded amount rather than inflating every entry by a third.
    const bytes = w * h * 4;
    total += bytes;
    if (texBucket(k) === 'generated:') generated += bytes;
    if (bytes > topBytes) { topBytes = bytes; topKey = k; topW = w; topH = h; }
  }
  return {
    totalMB:     round(total / MB),
    generatedMB: round(generated / MB),
    largestMB:   round(topBytes / MB),
    largest:     topKey ? `${texBucket(topKey) === 'generated:' ? topKey : texBucket(topKey)} ${topW}x${topH}` : '',
  };
}

/**
 * Top texture-cache buckets by entry count — the single most useful signal for a "baseTex keeps climbing"
 * report: it distinguishes an unbounded *asset* cache (many entries under one art directory, retained forever
 * because PIXI's URL cache never evicts) from a handful of legitimately-reused sheets. Capped output so the
 * detail string stays well under the anomaly truncation limit.
 */
function texTop(limit = 6): { k: string; n: number }[] {
  const c = (PIXI.utils as unknown as Record<string, Record<string, unknown> | undefined>).BaseTextureCache;
  if (!c) return [];
  const groups = new Map<string, number>();
  for (const key of Object.keys(c)) {
    const b = texBucket(key);
    groups.set(b, (groups.get(b) ?? 0) + 1);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => ({ k, n }));
}

/**
 * Application-wide singleton memory monitor. Installed once via install(app.ticker) at app.ts startup;
 * persists across scene transitions. When no battle is running the pool registry is empty, so only heap readings are reported.
 */
export class MemoryMonitor {
  private ticker: PIXI.Ticker | null = null;
  private stage: PIXI.Container | null = null;
  private accMs = 0;
  private lastWarnMs = -Infinity;
  /** Generated-texture count at the previous dump — lets each report carry the delta since last time, so a
   * single sample shows whether generated textures are climbing (leak) or flat (bounded), not just their level. */
  private lastGenTex = -1;
  /** Generated-texture count at the previous *sample* (every SAMPLE_EVERY_MS, not just on warn) — the budget
   * guard only fires when the count is over budget AND still growing, so a large-but-stable set stays quiet. */
  private lastSampledGenTex = -1;
  /** Decoded texture MB at the previous sample — the byte gate, like the count gate, only fires
   *  when it is over budget AND still growing, so a large-but-stable working set stays quiet. */
  private lastSampledTexMB = -1;

  install(ticker: PIXI.Ticker, stage?: PIXI.Container): void {
    this.ticker = ticker;
    this.stage = stage ?? null;
    ticker.add(this.onTick);

    // Feed live GPU/texture counters into ANR reports: a freeze that always fires with a huge baseTex count
    // points at texture pressure, whereas one at a low count is a pure compute stall. Cheap counters only —
    // no scene-graph walk here (the watchdog fires *during* a stall; walking the tree would worsen it).
    // `texMB` is in that budget: one pass over the cache keys reading two numbers off each entry, a few
    // hundred iterations against the 200k-node walk that is deliberately excluded — and after 2026-08-25
    // it is the counter most likely to explain a stall, since a count of 3 hid a third of a gigabyte.
    setAnrContextProvider(() => ({
      gpu: {
        tex: cacheSize('TextureCache'),
        baseTex: cacheSize('BaseTextureCache'),
        ...(() => { const b = texBytes(); return b ? { texMB: b.totalMB, largestMB: b.largestMB } : {}; })(),
        tickers: this.ticker?.count ?? -1,
      },
    }));

    // WeChat Mini Game: the OS low-memory callback is the real budget gate (performance.memory is typically unavailable in the WeChat runtime).
    const wx = (globalThis as unknown as { wx?: { onMemoryWarning?: (cb: (res: { level?: number }) => void) => void } }).wx;
    wx?.onMemoryWarning?.((res) => {
      this.dump(`wx onMemoryWarning（level ${res?.level ?? '?'}）`);
    });
  }

  uninstall(): void {
    this.ticker?.remove(this.onTick);
    this.ticker = null;
  }

  private onTick = (): void => {
    this.accMs += this.ticker?.deltaMS ?? 16.7;
    if (this.accMs < SAMPLE_EVERY_MS) return;
    this.accMs = 0;

    // Two independent triggers, either of which files a report:
    //   ① JS heap over threshold (the classic pure-JS retention leak — needs performance.memory).
    //   ② generated (non-URL) base-texture count over budget AND still climbing — the GPU-side leak the
    //      heap gate is blind to (generated textures are mostly GPU memory). Works with no performance.memory,
    //      so it also covers Safari/WeChat where heap sampling is unavailable.
    //   ③ decoded texture BYTES over budget AND still climbing — the axis ② cannot express. A handful
    //      of oversized RenderTextures is a small count and a huge footprint (2026-08-25: three at
    //      111 MB), and it is bytes, not entries, that the OS kills a mobile WebView over.
    const heap = readHeap();
    const usedMB = heap ? heap.usedJSHeapSize / MB : 0;
    const threshold = warnThresholdMB();
    const heapOver = heap != null && usedMB >= threshold;

    const generated = genTexCount();
    const budget = genTexBudget();
    const genClimbing = this.lastSampledGenTex < 0 || generated > this.lastSampledGenTex;
    this.lastSampledGenTex = generated;
    const genOver = generated > budget && genClimbing;

    const tex = texBytes();
    const texMB = tex?.totalMB ?? 0;
    const texBudget = texBudgetMB();
    const texClimbing = this.lastSampledTexMB < 0 || texMB > this.lastSampledTexMB;
    this.lastSampledTexMB = texMB;
    const texOver = tex != null && texMB > texBudget && texClimbing;

    if (!heapOver && !genOver && !texOver) return;

    const t = nowMs();
    if (t - this.lastWarnMs < REWARN_EVERY_MS) return;
    this.lastWarnMs = t;
    this.dump(
      heapOver
        ? `JS heap ${usedMB.toFixed(0)}MB exceeds warning threshold of ${threshold}MB`
        : genOver
          ? `generated textures ${generated} exceed budget of ${budget} and still climbing (likely a Text/RenderTexture leak)`
          : `decoded textures ${texMB.toFixed(0)}MB exceed budget of ${texBudget}MB and still climbing (largest ${tex?.largest} at ${tex?.largestMB}MB)`,
    );
  };

  /** Immediately emit a memory + pool-usage warning (called when heap exceeds threshold or a wx low-memory signal is received). */
  private dump(reason: string): void {
    const heap = readHeap();
    const pools = snapshotPools();
    const heapInfo = heap
      ? { usedMB: round(heap.usedJSHeapSize / MB), totalMB: round(heap.totalJSHeapSize / MB), limitMB: round(heap.jsHeapSizeLimit / MB) }
      : 'unavailable';
    const poolTotal = { idle: pools.totalIdle, estMB: round(pools.totalBytes / MB, 2) };
    // PIXI-level counters: when pools are empty (poolTotal.estMB≈0) but the heap keeps growing, these three numbers identify which category of retention leak is occurring.
    const nodes = countNodes(this.stage);
    // `generated` (non-URL textures) + its delta since the last dump are the primary leak signal: baseTex alone
    // conflates the bounded URL-asset cache with the unbounded generated class. genDelta > 0 across dumps ⇒ a
    // generated-texture leak in progress; the accompanying nodes count separates a texture leak from a
    // scene-graph-retention leak (both surface as heap growth with empty pools — see the file header).
    const generated = genTexCount();
    const genDelta = this.lastGenTex >= 0 ? generated - this.lastGenTex : 0;
    this.lastGenTex = generated;
    // Bytes alongside the counts. `bytes` is the whole base-texture cache; `bake` is the subset this
    // app allocates on purpose and can name — its `largest` carries the bake cache key (e.g.
    // `lobbybg:3000x1080@3`), which is the difference between "a generated texture is huge" and
    // "this call site is huge". See texBytes()/bakeStats() for why counts alone were not enough.
    const bytes = texBytes();
    const baked = bakeStats();
    const gpu = {
      tex: cacheSize('TextureCache'),
      baseTex: cacheSize('BaseTextureCache'),
      generated,
      genDelta,
      ...(bytes ? { texMB: bytes.totalMB, genMB: bytes.generatedMB, largest: bytes.largest, largestMB: bytes.largestMB } : {}),
      bake: {
        n: baked.count,
        MB: round(baked.bytes / MB),
        ...(baked.largest ? { top: `${baked.largest.key} ${baked.largest.w}x${baked.largest.h}`, topMB: round(baked.largest.bytes / MB) } : {}),
      },
      nodes: nodes >= NODE_WALK_CAP ? `${NODE_WALK_CAP}+` : nodes,
      tickers: this.ticker?.count ?? -1,
    };
    // Which art directories dominate the base-texture cache — categorizes a "baseTex climbing" leak
    // (unbounded URL-keyed asset cache) down to the specific folder without a follow-up repro.
    const tex = texTop();
    log.warn(reason, {
      heap: heapInfo,
      pools: pools.rows.map((r) => ({ label: r.label, idle: r.idle, estKB: round(r.estBytes / 1024) })),
      poolTotal,
      gpu,
      texTop: tex,
    });
    // Also forward to the "full anomaly reporting" channel (parallel to the directed-sampling ring buffer):
    // any client on the network that exceeds the memory threshold reports directly to Loki.
    // reportAnomaly has a 60 s cooldown for the mem type internally, so the 5 s sampling cadence will not flood the logs.
    // `scene` reuses SceneManager's activeScene stamp (already fed to anr reports) so a nodes/heap spike can be
    // attributed to a screen without a follow-up repro — see the 2026-08-02 Loki triage that couldn't tell which
    // scene held 1487 nodes vs. the usual ~350-390.
    const scene = getActiveScene();
    reportAnomaly('mem', reason, { ...(scene ? { scene } : {}), heap: heapInfo, poolTotal, gpu, texTop: tex });
  }
}
