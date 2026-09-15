// memoryBudgets.ts — the four numbers `MemoryMonitor` judges against, and why each one is that
// number.
//
// Split out of MemoryMonitor.ts so they can be read without pulling PIXI in: the browser sweep that
// MEASURES the bake ceiling (`test/browser/bakeBudget.spec.ts`) runs in a plain Playwright process,
// and a budget asserted against a copy of itself proves nothing. Policy here, mechanism there.

// Default JS heap warning threshold (MB). A healthy match JS heap is typically well below 150 MB; 400 MB
// gives enough headroom to avoid false positives from normal fluctuations while still catching unbounded
// leak growth (which will eventually cross it). Can be tightened per platform via
// localStorage.setItem('nw_mem_warn_mb', '250') (e.g. low-end Android / WeChat).
export const DEFAULT_WARN_MB = 400;

/**
 * Soft budget for **generated** (non-URL) base textures — Text/RenderTexture/generateTexture results
 * (see genTexCount). A healthy client keeps only a bounded live set (on-screen labels, baked chrome, a
 * handful of tokens); legitimate peaks sit in the low hundreds. Crossing this *while still climbing* is a
 * generated-texture leak caught early — before it inflates the JS heap past DEFAULT_WARN_MB (a generated
 * texture is mostly GPU memory, which usedJSHeapSize barely reflects, so this fires long before the heap
 * gate would). Tunable via localStorage.setItem('nw_gentex_budget', '400'). This is the regression guard
 * for the leak class fixed in the overlay-scene teardown pass.
 */
export const DEFAULT_GEN_TEX_BUDGET = 600;

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
export const DEFAULT_TEX_BUDGET_MB = 256;

/**
 * Soft budget for the **bake cache**, counted in BACKBUFFERS rather than in megabytes — and it
 * needs its own gate because the budget above cannot see this cache at all.
 *
 * `texBytes()` scans `PIXI.utils.BaseTextureCache`, and `PIXI.RenderTexture.create()` never
 * registers there. So every texture `render/bake.ts` mints — the page backgrounds, which are the
 * largest single allocation this client makes and the ones that killed a WKWebView on 2026-08-25 —
 * is invisible to all three gates above: not in the byte total, not in the generated count, and
 * GPU-side so barely in the heap. Adding a byte metric (`bakeStats`, ADR-073) was not the same as
 * wiring it into a budget; until this gate it only ever appeared in reports that some OTHER gate
 * had already triggered.
 *
 * **Why not megabytes.** Page-sized bakes are sized for the device pixels they cover, so the same
 * healthy behaviour costs 5.4 MB per page on a phone and ~24 MB on a wide high-DPI desktop — a 4x
 * spread that no single MB number can straddle: set it for the phone and every retina desktop
 * reports, set it for the desktop and a phone would have to quadruple before anything fires.
 * Counted in backbuffers (`render/bake.ts`'s `screenBytes`), both devices read the same.
 *
 * **24 is set off the measured ceiling.** This cache never evicts, so the number that matters is a
 * whole session's ceiling, and it is exactly measurable: walking all 36 layout stops
 * (`test/browser/bakeBudget.spec.ts`, 2026-09-14) holds **10.9 backbuffers** on a 1280x631 desktop
 * at dpr 1.5 (26 entries / 75.7 MB) and **11.9** on a 390x844 phone (25 entries / 59.8 MB) — a 27%
 * gap in MB and a 9% gap in the unit that is actually budgeted. Double the worse of the two, so a
 * healthy client never reports and a report means something when it arrives. For scale: the
 * 2026-08-25 crash baked three page layers at 16x oversampling — 48 backbuffers in the lobby
 * alone — which this would have named on the first sample it survived.
 * Tunable via localStorage.setItem('nw_bake_budget_screens', '16').
 *
 * The walk that produced it asserts against THIS constant rather than a copy: a budget and the
 * measurement that proves it is met are the two halves of one decision.
 */
export const DEFAULT_BAKE_BUDGET_SCREENS = 24;

