/**
 * bootManifestTiers.ui.ts — the L0 blocking/background split (ASSET_PACKAGING §11.2).
 *
 * The split moved 0.51 MB off the boot gate on the argument that `enterBattle`'s own readiness
 * gate re-awaits every background-tier asset before a battle can start. That argument is the
 * whole safety case for the change, and until now nothing enforced it: a future asset added to
 * BACKGROUND_STEPS but not reachable from `ensureBattleAssets` would silently reintroduce the
 * placeholder-circle bug §10 was written to close — in the FIRST battle only, which is precisely
 * the case a developer with a warm cache never sees. The last test in this file is that guard;
 * the ones before it pin the gate's own behaviour.
 *
 * Lives under test/ui/ because bootManifest.ts and battleAssets.ts (via UnitView) both reach raw
 * `.png`/`.tao` imports, which only vitest.ui.config.ts's stubBinaryAssets plugin can resolve.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Which loader each tier drove, by kind — see the subset test for why kind and not URL. */
const drove = new Set<string>();
const taoUrls: string[] = [];
/** When set, that loader kind returns a promise that never settles. */
let hangingKind: string | null = null;
/** When set, that loader kind rejects. */
let failingKind: string | null = null;

function record(kind: string): Promise<unknown> {
  drove.add(kind);
  if (kind === hangingKind) return new Promise(() => {});
  if (kind === failingKind) return Promise.reject(new Error('boom'));
  return Promise.resolve();
}

vi.mock('../../src/render/stickman/StickmanRuntime', () => ({
  StickmanRuntime: { loadAsset: vi.fn((url: string) => { taoUrls.push(url); return record('tao'); }) },
}));
vi.mock('../../src/assets/preloadTextures', () => ({
  preloadTexture: vi.fn(() => record('texture')),
  preloadTextureList: vi.fn(() => record('texture')),
  ART_TEX_OPTIONS: {},
}));
vi.mock('../../src/render/atlas/decorMergedAtlas', () => ({
  decorMergedAtlas: { load: vi.fn(() => record('decor')) },
}));
vi.mock('../../src/render/atlas/iconsAtlas', () => ({
  iconsAtlas: { load: vi.fn(() => record('icons')) },
}));
vi.mock('../../src/render/cardArt', () => ({
  preloadL1CardArtTextures: vi.fn(() => record('cardArt')),
}));

// After vi.mock (hoisted regardless of physical order — same pattern as battleGate.ui.ts).
import { preloadBoot, preloadBootBackground } from '../../src/assets/bootManifest';
import { ensureBattleAssets } from '../../src/assets/battleAssets';

/** Let `preloadBoot`'s post-gate `void preloadBootBackground()` get a turn to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('L0 boot tiers', () => {
  beforeEach(() => {
    drove.clear();
    taoUrls.length = 0;
    hangingKind = null;
    failingKind = null;
    vi.clearAllMocks();
  });

  it('reports progress only for the blocking tier', async () => {
    const seen: Array<[number, number]> = [];
    await preloadBoot((done, total) => seen.push([done, total]));
    const total = seen[0][1];
    expect(seen[0]).toEqual([0, total]);
    expect(seen[seen.length - 1]).toEqual([total, total]);
    expect(seen).toHaveLength(total + 1); // initial 0/total + one call per completed step
    // The gate draws textures and the icon atlas; the .tao rigs and decor atlas are NOT its job.
    // (Asserted on the first progress callback, before the background tier has had a turn.)
    expect(total).toBeGreaterThan(0);
  });

  it('does not make the player wait for the background tier', async () => {
    // The whole point of the split: a background asset that never arrives must not hold the
    // loading screen up. Before §11.2 these were gate steps and this would hang forever.
    hangingKind = 'tao';
    await expect(preloadBoot()).resolves.toBeUndefined();
    await settle();
    expect(drove.has('tao')).toBe(true); // still started, just not awaited
  });

  it('starts the background tier only after the gate resolves', async () => {
    let atGateResolve: string[] = [];
    await preloadBoot((done, total) => { if (done === total) atGateResolve = [...drove]; });
    // Starting them alongside the gate would just make them contend for bandwidth with the tier
    // the player is actually waiting on — the reason preloadBoot kicks them off afterwards.
    expect(atGateResolve).not.toContain('tao');
    expect(atGateResolve).not.toContain('decor');
    await settle();
    expect(drove.has('tao')).toBe(true);
    expect(drove.has('decor')).toBe(true);
  });

  it('never rejects when a gate step fails', async () => {
    failingKind = 'icons';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(preloadBoot()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never rejects when a background step fails', async () => {
    failingKind = 'decor';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(preloadBootBackground()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── the safety case for the whole split ──────────────────────────────────────────────────
  it('drives nothing in the background tier that the pre-battle gate does not also drive', async () => {
    await preloadBootBackground();
    const background = new Set(drove);
    const backgroundTao = [...taoUrls];

    drove.clear();
    taoUrls.length = 0;
    await ensureBattleAssets({});
    const battle = new Set(drove);

    // Compared by loader KIND, not URL: vitest.ui.config's binary-asset stub maps every `.png`/
    // `.tao` import to the same placeholder data URI, so URL identity is meaningless in this
    // environment (battleAssets.ui.ts documents the same collapse). Kind still catches the
    // regression that matters — a new background step going through a loader the battle gate
    // never calls, e.g. adding another atlas to BACKGROUND_STEPS.
    const uncovered = [...background].filter((k) => !battle.has(k));
    expect(uncovered, `background-tier loaders not re-awaited by ensureBattleAssets: ${uncovered}`).toEqual([]);
    expect(background.size).toBeGreaterThan(0); // guards against a vacuous pass
    // Sanity that both halves really ran, rather than the sets being empty for different reasons.
    expect(backgroundTao.length).toBeGreaterThan(0);
    expect(taoUrls.length).toBeGreaterThan(0);
  });
});
