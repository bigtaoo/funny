// `MapService.tileDocView` — the tile→view mapper every map read goes through (core/map.ts), unit-tested
// with a bare fake core (it touches nothing but `deps.now`, and only for its default argument).
//
// Written for the 2026-09-04 garrison-regen change (SLG_DESIGN §5.6), which turned the view's
// `garrison` field from a stored-field pass-through into `liveGarrison(o, now)`. That makes the map
// readout INTEL — "how hard is this tile to take right now", the same number the siege resolves
// against — rather than a report of the owner's ledger, and it is the only place a player can see the
// heal at all. Two properties are worth pinning at this seam and nowhere else: the healed figure
// really reaches the view, and the "0 → omit the key entirely" shape the field always had survived
// being rewritten as an IIFE (a `garrison: 0` on the wire would render as a 0-troop tile — exactly the
// "free capture" reading this feature exists to remove).
import { describe, expect, it } from 'vitest';
import { TILE_GARRISON_REGEN_MS, tileGarrisonBaseline } from '@nw/shared';
import { MapService } from '../src/core/map';
import type { WorldCore } from '../src/core';
import type { YieldService } from '../src/core/yield';
import type { VisionService } from '../src/core/vision';
import type { TileDoc } from '../src/db';

const W = 's1';
const ME = 'acc-me';
const OTHER = 'acc-other';
const NOW = 1_700_000_000_000;

function svc(now = NOW): MapService {
  return new MapService(
    { deps: { now: () => now } } as unknown as WorldCore,
    {} as unknown as YieldService,
    {} as unknown as VisionService,
  );
}

function tile(overrides: Partial<TileDoc> = {}): TileDoc {
  return {
    _id: `${W}:3:4`, worldId: W, x: 3, y: 4, type: 'territory', level: 5,
    ownerId: OTHER, garrison: 0, garrisonRegenAt: NOW, rev: 0,
    ...overrides,
  } as unknown as TileDoc;
}

describe('MapService.tileDocView — garrison is the LIVE figure', () => {
  it('shows a stripped enemy tile healing back up, not the 0 its document still holds', () => {
    const half = tile({ garrisonRegenAt: NOW - TILE_GARRISON_REGEN_MS / 2 });
    expect(svc().tileDocView(half, ME, undefined, NOW).garrison).toBe(tileGarrisonBaseline(5) / 2);
    expect(half.garrison).toBe(0); // and the document itself is untouched — the heal is never persisted
  });

  it('omits the field entirely when nothing stands there, rather than sending a literal 0', () => {
    // The pre-existing shape (`...(o.garrison ? {garrison} : {})`), kept through the rewrite. A tile
    // that reports `garrison: 0` reads to the client as a scouted, empty tile; an ABSENT field reads as
    // "no intel" — which is what the fog gate (gateIntel) deletes it down to anyway.
    const fresh = tile({ garrison: 0, garrisonRegenAt: NOW });
    expect('garrison' in svc().tileDocView(fresh, ME, undefined, NOW)).toBe(false);
  });

  it('leaves an unowned tile alone — a neutral tile\'s strength is procedural, computed at the point of use', () => {
    const neutral = tile({ ownerId: undefined, garrison: 40, garrisonRegenAt: NOW - TILE_GARRISON_REGEN_MS });
    expect(svc().tileDocView(neutral, ME, undefined, NOW).garrison).toBe(40);
  });

  it('never invents a garrison for a base anchor — the capital defends with in-base teams (ADR-026 §2)', () => {
    const base = tile({ type: 'base', garrison: 0, garrisonRegenAt: NOW - TILE_GARRISON_REGEN_MS });
    expect('garrison' in svc().tileDocView(base, ME, undefined, NOW)).toBe(false);
  });

  it('a reinforced surplus is shown as stored — the owner\'s own troops are not capped by the baseline', () => {
    const stacked = tile({ ownerId: ME, garrison: 9_000, garrisonRegenAt: NOW - TILE_GARRISON_REGEN_MS });
    const view = svc().tileDocView(stacked, ME, undefined, NOW);
    expect(view.garrison).toBe(9_000);
    expect(view.mine).toBe(true);
  });

  it('falls back to the core clock when the caller passes no `now`, so every read path heals alike', () => {
    // getTile/getMap pass an explicit instant; anything that does not must not silently freeze the heal
    // at the epoch (which would read as "fully healed" for every owned tile).
    const half = tile({ garrisonRegenAt: NOW - TILE_GARRISON_REGEN_MS / 2 });
    expect(svc(NOW).tileDocView(half, ME).garrison).toBe(tileGarrisonBaseline(5) / 2);
  });
});
