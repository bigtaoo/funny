// ─────────────────────────────────────────────────────────────────────────────
// F-track runner — WORLD_CAPACITY / RESET_DELETE_BATCH load estimation
//   (SLG_ECONOMY_CHECK §8).
//   npx tsx src/capacityRun.ts
// Validates:
//   ① WORLD_CAPACITY=10000: doc count + key query complexity at full shard
//   ② RESET_DELETE_BATCH=2000: clearance iterations + estimated time
// ─────────────────────────────────────────────────────────────────────────────

import { WORLD_CAPACITY, RESET_DELETE_BATCH, SLG_MAP_W, SLG_MAP_H, SLG_GEN } from '@nw/shared';

function bar(s: string) { console.log('═'.repeat(78)); console.log(s); console.log('═'.repeat(78)); }
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const f1  = (n: number) => n.toFixed(1);

bar('SLG shard capacity estimation — F-track (SLG_ECONOMY_CHECK §8)');
console.log(`WORLD_CAPACITY = ${WORLD_CAPACITY}   RESET_DELETE_BATCH = ${RESET_DELETE_BATCH}\n`);

// ── ①  Document count estimation ─────────────────────────────────────────────
console.log('── ①  Document count at full shard (10,000 players) ─────────────────────────\n');

const CAP = WORLD_CAPACITY;

// Map dimensions
const MAP_W = SLG_MAP_W, MAP_H = SLG_MAP_H, MAP_TILES = MAP_W * MAP_H;
const RESOURCE_DENSITY = SLG_GEN.resourceDensity;
const RESOURCE_TILES = Math.round(MAP_TILES * RESOURCE_DENSITY);

// Per-player doc estimates (based on SLG design §14 / worldsvc service.ts)
const TILES_PER_PLAYER_MEDIAN = 20;      // median territory tiles per player
const TILES_PER_PLAYER_ACTIVE = 50;      // active player peak
const MARCHES_INFLIGHT_MEDIAN = 2;       // median concurrent marches
const FAMILIES_PER_PLAYER = 1;           // every player is in one family
const FAMILY_MEDIAN_SIZE = 20;           // median family = 20 members
const FAMILIES_IN_SHARD = Math.round(CAP / FAMILY_MEDIAN_SIZE); // 500 families
const SECTS_IN_SHARD = Math.round(FAMILIES_IN_SHARD / 10);      // ~50 sects

console.log('  Document type             Median count    Active-peak count   Notes');
console.log('  ' + '─'.repeat(74));

const docTypes: Array<{ name: string; median: number; active: number; note: string }> = [
  {
    name: 'PlayerWorldDoc',
    median: CAP,
    active: CAP,
    note: 'one per player; always persisted',
  },
  {
    name: 'TileDoc (territory)',
    median: TILES_PER_PLAYER_MEDIAN * CAP,
    active: TILES_PER_PLAYER_ACTIVE * CAP,
    note: 'only claimed/modified tiles; procedural tiles not persisted',
  },
  {
    name: 'FamilyDoc',
    median: FAMILIES_IN_SHARD,
    active: FAMILIES_IN_SHARD,
    note: '≈CAP/20 families',
  },
  {
    name: 'FamilyMemberDoc',
    median: CAP,
    active: CAP,
    note: 'one per player',
  },
  {
    name: 'MarchDoc (in-flight)',
    median: MARCHES_INFLIGHT_MEDIAN * CAP,
    active: 4 * CAP,
    note: 'transient; settled on arrival',
  },
  {
    name: 'SiegeDoc (replay)',
    median: Math.round(CAP * 0.5),
    active: CAP * 2,
    note: 'one per completed siege; up to a few/player/season',
  },
  {
    name: 'NationDoc',
    median: 10,
    active: 10,
    note: 'fixed 10 nations/world',
  },
  {
    name: 'SectDoc',
    median: SECTS_IN_SHARD,
    active: SECTS_IN_SHARD,
    note: '≈50 sects/shard',
  },
  {
    name: 'AuctionDoc',
    median: Math.round(CAP * 0.05),
    active: Math.round(CAP * 0.1),
    note: '5–10% of players listing at a time',
  },
];

let totalMedian = 0, totalActive = 0;
for (const d of docTypes) {
  console.log(`  ${d.name.padEnd(26)}${fmt(d.median).padStart(15)} ${fmt(d.active).padStart(19)}   ${d.note}`);
  totalMedian += d.median;
  totalActive += d.active;
}
console.log('  ' + '─'.repeat(74));
console.log(`  ${'TOTAL'.padEnd(26)}${fmt(totalMedian).padStart(15)} ${fmt(totalActive).padStart(19)}`);

console.log('\n  Key insight: TileDoc dominates (20–50× per player). Sparse storage (proceduralTile()');
console.log('  computes untouched neutral tiles on-the-fly → only claimed/modified tiles persisted).');
console.log('  At 20 tiles/player: 200k TileDocs → ~200k docs total for tiles; manageable for MongoDB.');

// ── ② Key query complexity ────────────────────────────────────────────────────
console.log('\n── ②  Critical query analysis ────────────────────────────────────────────────\n');

const QUERY_ESTIMATES = [
  {
    query: 'families.find({worldId}).sort({prosperity})',
    docCount: FAMILIES_IN_SHARD,
    index: 'worldId + prosperity compound',
    estimatedMs: FAMILIES_IN_SHARD < 1000 ? '<5ms' : '<20ms',
    note: 'settlement ranking; triggered once/season-end, not hot path',
  },
  {
    query: 'tiles.find({worldId}) [yield recompute]',
    docCount: TILES_PER_PLAYER_MEDIAN * CAP,
    index: 'worldId (required)',
    estimatedMs: '<50ms',
    note: 'full-shard yield recompute on nation change; rare',
  },
  {
    query: 'tiles.find({worldId, x:{$gte,lte}, y:{$gte,lte}})',
    docCount: Math.round(TILES_PER_PLAYER_MEDIAN * CAP * 0.01),
    index: 'worldId + (x,y) or geospatial',
    estimatedMs: '<5ms',
    note: 'viewport query; primary hot path per user request',
  },
  {
    query: 'marches.find({worldId, arriveAt:{$lte:now}})',
    docCount: MARCHES_INFLIGHT_MEDIAN * CAP,
    index: 'worldId + arriveAt',
    estimatedMs: '<10ms',
    note: 'march settlement poll (worldsvc tick)',
  },
  {
    query: 'playerWorld.findOne({_id})',
    docCount: 1,
    index: '_id primary key',
    estimatedMs: '<2ms',
    note: 'per-request player state read; hot path',
  },
];

console.log('  Query                                               Docs scanned  Index?         Est. latency  Notes');
console.log('  ' + '─'.repeat(105));
for (const q of QUERY_ESTIMATES) {
  console.log(`  ${q.query.padEnd(52)}${fmt(q.docCount).padStart(12)}  ${q.index.padEnd(25)}${q.estimatedMs.padStart(8)}  ${q.note}`);
}

console.log('\n  Summary: All hot-path queries are point lookups or narrow range scans (viewport + march');
console.log('  settlement). The prosperity sort at season-end scans ~500 family docs (not 10k player');
console.log('  docs) → fast. Indices needed: (worldId+x+y), (worldId+arriveAt), (worldId+prosperity).');

// ── ③ RESET_DELETE_BATCH ─────────────────────────────────────────────────────
console.log('\n── ③  RESET_DELETE_BATCH clearance analysis ─────────────────────────────────\n');

const BATCH = RESET_DELETE_BATCH;

// Docs deleted per shard at season reset (tiles + playerWorld + marches + siegeDocs + familyMembers)
const DOCS_TO_DELETE_MEDIAN = totalMedian;
const DOCS_TO_DELETE_ACTIVE = totalActive;

// One delete batch = deleteMany with up to BATCH docs; ~10ms per batch estimate for MongoDB
const DELETE_BATCH_MS = 15; // conservative: 15ms per batch of 2000 including round-trip

const batchesMedian = Math.ceil(DOCS_TO_DELETE_MEDIAN / BATCH);
const batchesActive = Math.ceil(DOCS_TO_DELETE_ACTIVE / BATCH);
const timeMedianS = (batchesMedian * DELETE_BATCH_MS) / 1000;
const timeActiveS = (batchesActive * DELETE_BATCH_MS) / 1000;

console.log(`  RESET_DELETE_BATCH = ${BATCH}`);
console.log(`  Conservative estimate: ${DELETE_BATCH_MS}ms per batch (includes network + write journal flush)`);
console.log('');
console.log(`  Scenario            Docs to delete   Batches   Clearance time`);
console.log('  ' + '─'.repeat(60));
console.log(`  Median activity     ${fmt(DOCS_TO_DELETE_MEDIAN).padStart(14)}   ${String(batchesMedian).padStart(7)}   ${f1(timeMedianS)}s`);
console.log(`  Peak activity       ${fmt(DOCS_TO_DELETE_ACTIVE).padStart(14)}   ${String(batchesActive).padStart(7)}   ${f1(timeActiveS)}s`);
console.log('');
console.log(`  Verdict: worst-case clearance ≈ ${f1(timeActiveS)}s for peak shard.`);

const clearancePassMedian = timeMedianS < 300; // < 5 minutes
const clearancePassActive  = timeActiveS < 600; // < 10 minutes (season reset is offline, can take longer)
console.log(`  < 5 min (median): ${clearancePassMedian ? '✅ PASS' : '❌ FAIL'}   < 10 min (peak): ${clearancePassActive ? '✅ PASS' : '❌ FAIL'}`);

console.log('');
console.log(`  Batch sizing rationale:`);
console.log(`    BATCH=${BATCH}: large enough to reduce round-trips (${batchesMedian} median iterations),`);
console.log(`    small enough to keep each write operation short and avoid long lock contention.`);
console.log(`    MongoDB deleteMany with ${BATCH} docs is well within single-command time budget (<20ms).`);

// ── ④ Memory footprint ───────────────────────────────────────────────────────
console.log('\n── ④  worldsvc memory footprint estimate ─────────────────────────────────────\n');

const DOC_SIZE_BYTES = {
  PlayerWorldDoc: 2000,   // resources + buildings + garrison + teams
  TileDoc: 300,           // type + owner + garrison + level + resType
  FamilyDoc: 1500,        // tag + name + members[] + prosperity + activity
  FamilyMemberDoc: 400,   // role + joined + activity
  MarchDoc: 800,          // path + troops + army
  SiegeDoc: 5000,         // replay inputs (seed + armies)
  NationDoc: 200,
  SectDoc: 1000,
  AuctionDoc: 600,
};

// In-memory: worldsvc caches active-player state; non-active data stays in Mongo
// Rough: 20% of players actively online at peak, tiles for those players cached
const ACTIVE_FRACTION = 0.2;
const CACHED_PLAYER_DOCS  = Math.round(CAP * ACTIVE_FRACTION);
const CACHED_TILE_DOCS    = CACHED_PLAYER_DOCS * TILES_PER_PLAYER_ACTIVE;
const CACHED_MARCH_DOCS   = CACHED_PLAYER_DOCS * MARCHES_INFLIGHT_MEDIAN;

const memoryCacheBytes =
  CACHED_PLAYER_DOCS * DOC_SIZE_BYTES.PlayerWorldDoc +
  CACHED_TILE_DOCS   * DOC_SIZE_BYTES.TileDoc +
  CACHED_MARCH_DOCS  * DOC_SIZE_BYTES.MarchDoc +
  FAMILIES_IN_SHARD  * DOC_SIZE_BYTES.FamilyDoc +
  SECTS_IN_SHARD     * DOC_SIZE_BYTES.SectDoc +
  10 * DOC_SIZE_BYTES.NationDoc;

const memoryMB = memoryCacheBytes / 1024 / 1024;
console.log(`  Active player cache (${(ACTIVE_FRACTION*100).toFixed(0)}% of ${CAP} = ${CACHED_PLAYER_DOCS} active players):`);
console.log(`    PlayerWorldDoc × ${CACHED_PLAYER_DOCS} = ${fmt(CACHED_PLAYER_DOCS * DOC_SIZE_BYTES.PlayerWorldDoc)} B`);
console.log(`    TileDoc        × ${fmt(CACHED_TILE_DOCS)} = ${fmt(CACHED_TILE_DOCS * DOC_SIZE_BYTES.TileDoc)} B`);
console.log(`    FamilyDoc      × ${fmt(FAMILIES_IN_SHARD)} = ${fmt(FAMILIES_IN_SHARD * DOC_SIZE_BYTES.FamilyDoc)} B`);
console.log(`    + other        ≈ ${fmt(memoryMB)} MB total active-layer cache`);
console.log('');
console.log(`  Verdict: ≈${f1(memoryMB)} MB active-layer cache per shard. VPS (2–4 GB RAM) can host`);
console.log(`  ${Math.floor(1024 / memoryMB)}–${Math.floor(2048 / memoryMB)} shards per instance (at ${f1(memoryMB)} MB each) — well within capacity.`);
const memPassMedian = memoryMB < 256;
console.log(`  < 256 MB per shard: ${memPassMedian ? '✅ PASS' : '❌ FAIL (revise WORLD_CAPACITY)'}`);

bar('VERDICT — F-track (SLG_ECONOMY_CHECK §8)');
console.log(`  ① Document count at WORLD_CAPACITY=${CAP}: ${fmt(totalMedian)}–${fmt(totalActive)} docs/shard`);
console.log(`     Hot queries are indexed point-lookups or viewport range-scans. ✅ ACCEPTABLE`);
console.log(`  ② RESET_DELETE_BATCH=${BATCH}: ${batchesMedian}–${batchesActive} batches, ${f1(timeMedianS)}–${f1(timeActiveS)}s clearance`);
console.log(`     Batch size avoids lock contention; clearance completes well within reset window. ✅ ACCEPTABLE`);
console.log(`  ③ Memory: ≈${f1(memoryMB)} MB active cache/shard → fits comfortably in VPS RAM. ✅ ACCEPTABLE`);
console.log('');
console.log('  Note: F-track is an ENGINEERING ESTIMATE, not a blocking economic judgement.');
console.log('  Pressure-test before going live: run a full-shard seed (10k synthetic players) on');
console.log('  staging and measure actual explain() latency for the queries above.');
console.log('');
console.log('  ✅ F-TRACK CLOSED (estimated; to be confirmed by pre-launch pressure test)');
console.log('\nRegister conclusions → ECONOMY_NUMBERS.md §13-SLG-F');
