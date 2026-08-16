// Guards the 2026-08-15 reward-icon unification (render/rewardIcon.ts). Every reward row in the
// game (daily check-in / daily weekly chest / battle pass / events / recharge / mail attachments)
// used to hand-roll its own `kind → IconKind` table, and three of those kinds (`card`/`equipment`/
// `skin`) were still resolving to the *procedural* SketchPen glyphs long after AI line art existed
// — the weekly-chest tab drew a program-drawn shield right under a real AI-drawn material bitmap
// (user bug report). The regression this test blocks is someone mapping a reward kind back onto a
// procedural `IconKind` (or onto no picture at all) instead of the shared AI-backed resolver.
//
// No pixi rendering here — the assertions are on the resolver's *routing*, not on pixels. Lives in
// test/render only because importing rewardIcon.ts pulls pixi.js-legacy.
// Run: npm test — the default suite's `test/**/*.test.ts` include picks this up. There is no
// separate render suite (vitest.render.config.ts was deleted 2026-08-15; see icons.test.ts).
import { describe, it, expect, vi } from 'vitest';
// The two real atlas manifests, imported for their frame *names* only (no decode). The kind strings
// this module hands to buildCoinIcon/buildMaterialIcon have to exist in these, or the atlas lookup
// misses and every coin/material reward silently falls back to a procedural glyph — the exact 2026-08-15
// bug, just on the routes the faked builders below can't see.
import coinAtlasData from '../../src/assets/shop/coins.json';
import iconsAtlasData from '../../src/assets/icons/icons_atlas.json';
// Type-only (erased at runtime, so no server module is loaded): the reward-kind unions of every
// endpoint that feeds a reward row, used for the exhaustiveness table at the end of the first block.
// Not via `@nw/shared` — that alias points at the browser-safe SLG slice only (see vitest.config.ts).
import type { CheckinRewardKind, WeeklyChestRewardKind } from '../../../server/shared/src/retention';
import type { BpRewardKind } from '../../../server/shared/src/battlepass';
import type { RechargeRewardKind } from '../../../server/shared/src/rechargeMilestone';
import type { MailAttachmentKind } from '../../../server/shared/src/social';

// All three builders share the real `(kind, size, color)` shape. Spell the params out (rather than
// `vi.fn(() => …)`) so vitest infers a 3-tuple for `mock.calls` — a zero-arg mock infers `[]` and
// every `calls[0][0]` assertion below becomes a TS2493 under `npm run typecheck`. That failure is
// invisible to `npm test` (esbuild strips types), so it only ever surfaces in CI's typecheck step,
// which is how this file shipped red on 2026-08-15. Keep the params typed when adding a fake here.
type BuildIconArgs = [kind: string, size: number, color: number];
const buildIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'drawn' }));
const buildCoinIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'coin' }));
const buildMaterialIcon = vi.fn((..._a: BuildIconArgs) => ({ kind: 'material' }));

// The three art-warming loaders are fakes too, so `preloadRewardIconArt` can be driven through its
// failure paths without real network/decode work.
const preloadTabIconTextures = vi.fn((): Promise<void> => Promise.resolve());
const loadCoinIconAtlas = vi.fn((): Promise<void> => Promise.resolve());
const loadMaterialAtlas = vi.fn((): Promise<void> => Promise.resolve());

vi.mock('../../src/render/icons', () => ({
  buildIcon: (...a: BuildIconArgs) => buildIcon(...a),
  preloadTabIconTextures: () => preloadTabIconTextures(),
}));
vi.mock('../../src/render/atlas/coinIconAtlas', () => ({
  buildCoinIcon: (...a: BuildIconArgs) => buildCoinIcon(...a),
  loadCoinIconAtlas: () => loadCoinIconAtlas(),
}));
vi.mock('../../src/render/atlas/materialAtlas', () => ({
  buildMaterialIcon: (...a: BuildIconArgs) => buildMaterialIcon(...a),
  loadMaterialAtlas: () => loadMaterialAtlas(),
}));

const { buildRewardIcon, coinIconTier, materialKind, preloadRewardIconArt } =
  await import('../../src/render/rewardIcon');

/** The raster AI tab-icon kinds the three item rewards must reuse — never `cards`/`armor`/`brush`. */
const AI_ITEM_ICON: Record<string, string> = {
  card: 'rosterIcon',
  equipment: 'equipIcon',
  skin: 'skinIcon',
};

describe('buildRewardIcon — single source of truth for reward pictures', () => {
  it.each(Object.entries(AI_ITEM_ICON))(
    'routes a %s reward to the AI %s art, not a procedural glyph',
    (kind, iconKind) => {
      buildIcon.mockClear();
      const out = buildRewardIcon({ kind, count: 1 }, 40, 0x336644);
      expect(out).not.toBeNull();
      expect(buildIcon).toHaveBeenCalledTimes(1);
      expect(buildIcon.mock.calls[0][0]).toBe(iconKind);
    },
  );

  // The case above pins *which* IconKind each item reward asks for, but it cannot tell whether that
  // kind is AI art or a procedural glyph — `buildIcon` is faked here, so 'cards' and 'rosterIcon'
  // look identical to it. Someone reverting this module and its expectation table together (exactly
  // the 2026-08-15 bug, which had `card`→'cards'/`equipment`→'armor'/`skin`→'brush') would keep this
  // file green. So check the expectation table itself against the real icons.ts: a raster tab icon
  // is precisely one that has NO entry in the exported `DRAW` dispatch record — `DrawableIconKind`
  // is `Exclude<IconKind, RasterIconKind>`, so a procedural kind is always a DRAW key and an AI
  // raster kind never is. importActual bypasses the vi.mock above to read the genuine table.
  it('picks raster AI kinds for all three item rewards — never a procedural DRAW glyph', async () => {
    const realIcons = await vi.importActual<typeof import('../../src/render/icons')>(
      '../../src/render/icons',
    );
    const regressedToProcedural = Object.entries(AI_ITEM_ICON)
      .filter(([, iconKind]) => iconKind in realIcons.DRAW)
      .map(([rewardKind, iconKind]) => `${rewardKind} → ${iconKind}`);
    expect(regressedToProcedural).toEqual([]);
  });

  // Only arg 0 (the kind) was ever asserted, so every route could drop or transpose the size/ink and
  // no test would notice — reward rows would silently render at the wrong scale or in the wrong ink.
  // Distinct values per route so a cross-wired forward (coin size reaching the material call) fails.
  it('forwards the caller\'s size and ink unchanged down every art route', () => {
    buildIcon.mockClear(); buildCoinIcon.mockClear(); buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'card', count: 1 }, 41, 0x111111);
    buildRewardIcon({ kind: 'coins', count: 20 }, 42, 0x222222);
    buildRewardIcon({ kind: 'material', id: 'lead', count: 1 }, 43, 0x333333);
    buildRewardIcon({ kind: 'binding', count: 1 }, 44, 0x444444); // bare-material-as-kind route
    expect(buildIcon.mock.calls[0].slice(1)).toEqual([41, 0x111111]);
    expect(buildCoinIcon.mock.calls[0].slice(1)).toEqual([42, 0x222222]);
    expect(buildMaterialIcon.mock.calls.map((c) => c.slice(1))).toEqual([[43, 0x333333], [44, 0x444444]]);
  });

  // RechargeScene passes `{ coinKind: … }` for *every* reward in a tier, not just the coin ones
  // (RechargeScene.ts drawTierCard), so the coin override has to stay inert on the other routes —
  // hoisting that lookup above the kind dispatch would repaint its card/material rows as coin piles.
  it('ignores opts.coinKind on every non-coin route', () => {
    buildIcon.mockClear(); buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'card', count: 1 }, 40, 0x336644, { coinKind: 'coinChest' });
    buildRewardIcon({ kind: 'material', id: 'lead', count: 1 }, 40, 0x336644, { coinKind: 'coinChest' });
    expect(buildIcon.mock.calls[0][0]).toBe('rosterIcon');
    expect(buildMaterialIcon.mock.calls[0][0]).toBe('lead');
  });

  it('routes coins through buildCoinIcon (AI coin atlas), never buildIcon', () => {
    buildIcon.mockClear(); buildCoinIcon.mockClear();
    buildRewardIcon({ kind: 'coins', count: 20 }, 40, 0xd4a030);
    expect(buildCoinIcon).toHaveBeenCalledTimes(1);
    expect(buildIcon).not.toHaveBeenCalled();
  });

  it('lets a caller override the coin tier (RechargeScene\'s coarser payout scale)', () => {
    buildCoinIcon.mockClear();
    buildRewardIcon({ kind: 'coins', count: 60 }, 40, 0xd4a030, { coinKind: 'coinChest' });
    expect(buildCoinIcon.mock.calls[0][0]).toBe('coinChest');
  });

  // `count ?? 0` — a countless coin reward must still draw a picture, not crash or jump a tier.
  it('treats a coin reward with no count as the smallest pile', () => {
    buildCoinIcon.mockClear();
    buildRewardIcon({ kind: 'coins' }, 40, 0xd4a030);
    expect(buildCoinIcon.mock.calls[0][0]).toBe('coin');
  });

  it('routes materials through buildMaterialIcon (AI material atlas), by id and by bare kind', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', id: 'binding', count: 3 }, 40, 0x336644);
    buildRewardIcon({ kind: 'lead', count: 3 }, 40, 0x336644);
    expect(buildMaterialIcon.mock.calls.map((c) => c[0])).toEqual(['binding', 'lead']);
  });

  it('falls back to scrap for an unknown material id, or to null when the caller opts out', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', id: 'mat_unknown', count: 1 }, 40, 0x336644);
    expect(buildMaterialIcon.mock.calls[0][0]).toBe('scrap');
    // EventScene / mail want a text-only row rather than a wrong picture.
    expect(buildRewardIcon({ kind: 'material', id: 'mat_unknown', count: 1 }, 40, 0x336644,
      { materialFallback: null })).toBeNull();
  });

  // The fallback is `materialKind(id) ?? fallback` — a recognised id must win. Swapping those two
  // (or reaching for the fallback first) would make EventScene's `materialFallback: null` blank out
  // *every* material row, not just the unrecognised ones, and would make a caller that passes a
  // non-null fallback silently repaint known materials as scrap.
  it('never lets materialFallback override an id it does recognise', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', id: 'lead', count: 1 }, 40, 0x336644, { materialFallback: 'scrap' });
    expect(buildMaterialIcon.mock.calls[0][0]).toBe('lead');
    expect(buildRewardIcon({ kind: 'material', id: 'binding', count: 1 }, 40, 0x336644,
      { materialFallback: null })).not.toBeNull();
    // Same for the bare-material-as-kind route, which never consults the fallback at all.
    expect(buildRewardIcon({ kind: 'scrap', count: 1 }, 40, 0x336644,
      { materialFallback: null })).not.toBeNull();
  });

  // A `material` reward carrying no id at all (some endpoints omit it) is still a material.
  it('falls back to scrap when a material reward carries no id', () => {
    buildMaterialIcon.mockClear();
    buildRewardIcon({ kind: 'material', count: 2 }, 40, 0x336644);
    expect(buildMaterialIcon.mock.calls[0][0]).toBe('scrap');
  });

  it('returns null (no picture, caller draws a bare "+N") for stamina and unknown kinds', () => {
    expect(buildRewardIcon({ kind: 'stamina', count: 5 }, 40, 0x336644)).toBeNull();
    expect(buildRewardIcon({ kind: 'something_new', count: 1 }, 40, 0x336644)).toBeNull();
  });

  // `RewardLike.kind` is a bare `string`, so nothing in the type system connects this resolver to
  // the five server-side kind unions that feed it — a new kind ('ticket', a new currency…) added on
  // the server compiles fine here and renders as a pictureless row on all six screens. This table is
  // that missing link: `Record<Union, …>` makes TS demand a decision for every member (a new server
  // kind fails `npm run typecheck` until someone lands here), and the assertion checks the decision
  // is what the resolver actually does. 'text' means deliberately pictureless — the caller draws a
  // capsule or a bare "+N" — not "unimplemented".
  const SERVER_REWARD_KINDS: Record<
    CheckinRewardKind | WeeklyChestRewardKind | BpRewardKind | RechargeRewardKind | MailAttachmentKind,
    'picture' | 'text'
  > = {
    coins: 'picture',
    material: 'picture',
    card: 'picture',
    equipment: 'picture',
    skin: 'picture',
    stamina: 'text', // a clock/bolt would just repeat the "+N 体力" label next to it
    item: 'text', // auction/system mail's catch-all kind; mail.ts draws its generic capsule
  };

  it('draws a picture for every reward kind any server endpoint can emit', () => {
    const misrouted = Object.entries(SERVER_REWARD_KINDS).filter(([kind, want]) => {
      const drawn = buildRewardIcon({ kind, count: 1 }, 40, 0x336644) !== null;
      return drawn !== (want === 'picture');
    });
    expect(misrouted).toEqual([]);
  });
});

describe('coinIconTier / materialKind', () => {
  it('escalates the coin pile with the payout size', () => {
    expect([10, 40, 80, 150, 300].map(coinIconTier))
      .toEqual(['coin', 'coins', 'coinStack', 'coinSack', 'coinChest']);
  });

  // The row above sits exactly ON each threshold, so it pins `>=` against a change to `>`. This one
  // sits one short of each, pinning the other direction (a threshold quietly moved down), and adds
  // the degenerate payouts a stingy reward table can produce.
  it('holds each tier right up to the next threshold', () => {
    expect([39, 79, 149, 299].map(coinIconTier))
      .toEqual(['coin', 'coins', 'coinStack', 'coinSack']);
    expect([0, -1].map(coinIconTier)).toEqual(['coin', 'coin']);
  });

  // The DRAW cross-check above does this for the three item rewards; these two do it for the coin
  // and material routes. buildCoinIcon/buildMaterialIcon are faked here, so a tier renamed (or a
  // sixth tier added) without matching art would pass every other assertion in this file and then
  // miss the atlas frame at runtime — degrading to the procedural glyph with nothing going red.
  it('only names coin tiers the AI coin atlas has a frame for', () => {
    const frames = Object.keys(coinAtlasData.frames);
    const tiers = [...new Set([0, 40, 80, 150, 300, 99999].map(coinIconTier))];
    expect(tiers.filter((k) => !frames.includes(k))).toEqual([]);
  });

  it('only names materials the shared icons atlas has a frame for', () => {
    const frames = Object.keys(iconsAtlasData.frames);
    // Every id materialKind() accepts — the MaterialKind union, spelled out (it is a type, so it
    // cannot be enumerated at runtime); the assertion below keeps this list honest against the atlas.
    const mats = ['scrap', 'lead', 'binding'].map((id) => materialKind(id));
    expect(mats.filter((k) => k === null || !frames.includes(k))).toEqual([]);
  });

  it('accepts only the short material ids the server actually sends', () => {
    expect(['scrap', 'lead', 'binding'].map(materialKind)).toEqual(['scrap', 'lead', 'binding']);
    // `mat_`-prefixed ids are gacha's SaveData namespace, never a mail/reward attachment id.
    expect(materialKind('mat_lead')).toBeNull();
    expect(materialKind(undefined)).toBeNull();
  });
});

// This function had no coverage at all before 2026-08-16. Its whole contract is the failure
// behaviour: scenes call it fire-and-forget as `void preloadRewardIconArt().then(() => this.render())`,
// so if it ever propagated a rejection, a single 404 on one atlas would surface as an unhandled
// promise rejection on six unrelated screens — while the visible result of that failure is meant to
// be nothing worse than a procedural glyph for a frame or two. `Promise.allSettled` is what buys
// that, and swapping it for `Promise.all` is a one-word edit no other test would notice.
describe('preloadRewardIconArt', () => {
  const loaders = [preloadTabIconTextures, loadCoinIconAtlas, loadMaterialAtlas];

  it('warms all three art sources', async () => {
    loaders.forEach((l) => l.mockClear());
    await expect(preloadRewardIconArt()).resolves.toBeUndefined();
    for (const loader of loaders) expect(loader).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1, 2])('still resolves when art source %i fails', async (i) => {
    loaders.forEach((l) => l.mockClear());
    loaders[i].mockRejectedValueOnce(new Error('decode failed'));
    await expect(preloadRewardIconArt()).resolves.toBeUndefined();
    // The other two are still warmed — one bad source must not short-circuit the rest.
    for (const loader of loaders) expect(loader).toHaveBeenCalledTimes(1);
  });

  it('still resolves when every art source fails', async () => {
    loaders.forEach((l) => { l.mockClear(); l.mockRejectedValueOnce(new Error('offline')); });
    await expect(preloadRewardIconArt()).resolves.toBeUndefined();
  });
});
