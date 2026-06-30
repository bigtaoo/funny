/**
 * State-stream replay format (for out-of-game sharing, REPLAY_SHARE_DESIGN).
 *
 * Orthogonal to the input-stream replay ({@link Replay}): the input stream stores only player
 * commands and **re-runs the engine** to derive state at playback time — it depends on
 * engineVersion + numeric config, is authoritative, and is used for anti-cheat / ladder
 * settlement / in-game replay. The state stream stores the visual entity state of every frame
 * from the render layer; the player **dumb-plays only, never runs the engine**, and depends
 * solely on the render schema (`schemaVersion`). It is **untrusted** (client-generated,
 * forgeable) — intended only for public out-of-game viewing and must **never** enter the
 * anti-cheat / settlement path.
 *
 * This module is pure data + codec with no PIXI / engine dependency, making it easy to reuse
 * in the dumb player and in round-trip unit tests.
 */

/** Render schema version (not engineVersion). New fields are added incrementally without breaking old replays; on mismatch, degrade gracefully rather than hard-reject. */
export const STATE_SCHEMA_VERSION = 1;

/** Coordinate quantization precision: two decimal places (sufficient for display, saves size). */
export const STATE_POS_QUANT = 100;

// ── Full frame (in-memory form / consumed by the dumb player) ────────────────────────────────────────────────

/** Unit visual state (mirrors the fields actually read by UnitView.sync). `side`/`state`/`type` use the raw engine string enum values. */
export interface StateUnit {
  id: number;
  type: string;
  side: 0 | 1;
  /** Quantized fractional column (colExact). */
  col: number;
  /** Quantized fractional row (rowExact). */
  row: number;
  hp: number;
  maxHp: number;
  state: string;
}

/** Building visual state (mirrors BuildingView.sync). */
export interface StateBuilding {
  id: number;
  type: string;
  side: 0 | 1;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
}

/** Main base HP (drives BoardView crack / hit-pulse effects). */
export interface StateBase {
  owner: 0 | 1;
  hp: number;
  maxHp: number;
}

/** Complete entity snapshot for a single tick. */
export interface StateFrame {
  tick: number;
  units: StateUnit[];
  buildings: StateBuilding[];
  bases: StateBase[];
}

/** Replay header: metadata needed to render the background, HUD, and progress bar. */
export interface StateReplayHeader {
  /** Render schema version (not engineVersion). */
  schemaVersion: number;
  mode: string;
  /** Frame sample rate (Hz): the dumb player uses this to map tick advancement to wall-clock time. */
  tickRate: number;
  /** Tick of the last frame (full-scale value for the progress bar). */
  endTick: number;
  /** Winning side owner (0/1); -1 = draw / unknown. */
  winner: number;
  /** Board geometry, used to render the background grid. */
  board: { cols: number; rows: number; lanes: number[] };
  /** Display name + side for each player, used to render HUD labels. */
  players: { name: string; side: 0 | 1 }[];
}

/** Full-frame replay (after decoding / consumed frame-by-frame by the dumb player). */
export interface StateReplay {
  header: StateReplayHeader;
  frames: StateFrame[];
}

// ── Delta encoding (persisted to DB / wire format) ──────────────────────────────────────────────────

/**
 * Delta frame: records only entities that are **new or changed** relative to the previous frame
 * (unchanged entities are omitted) plus a list of removed ids.
 * All fields are optional — if a given entity type has no changes this frame, the entire section is omitted.
 */
export interface StateDeltaFrame {
  tick: number;
  /** Units that are new or have changed fields (full record per unit, avoiding per-field diff complexity). */
  u?: StateUnit[];
  /** Ids of units that vanished this frame (died / left the field). */
  ru?: number[];
  b?: StateBuilding[];
  rb?: number[];
  /** When any base HP changes, record the full base array (always 1–2 bases, so very small). */
  bs?: StateBase[];
}

/** Delta-encoded replay (wire format used for upload / DB persistence). */
export interface EncodedStateReplay {
  header: StateReplayHeader;
  frames: StateDeltaFrame[];
}

// ── Quantization ────────────────────────────────────────────────────────────────────────

/** Quantize a coordinate to display precision. */
export function quantizePos(v: number): number {
  return Math.round(v * STATE_POS_QUANT) / STATE_POS_QUANT;
}

/** Quantize HP to an integer (sufficient for display, and keeps delta comparisons stable). */
export function quantizeHp(v: number): number {
  return Math.round(v);
}

// ── Encode / Decode ──────────────────────────────────────────────────────────────────────

/**
 * **Static** signature of a unit (position excluded): any change in state / HP / type / side
 * must produce a keyframe — these are discrete events (walking↔attacking, taking damage, dying)
 * that cannot be recovered by interpolation. Position changes are **not** included here; they are
 * handled by keyframe thinning (see below).
 */
function staticSig(u: StateUnit): string {
  return `${u.type}|${u.side}|${u.hp}|${u.maxHp}|${u.state}`;
}
function buildingSig(b: StateBuilding): string {
  return `${b.type}|${b.side}|${b.col}|${b.row}|${b.hp}|${b.maxHp}`;
}
function basesSig(bs: StateBase[]): string {
  return bs.map((b) => `${b.owner}|${b.hp}|${b.maxHp}`).join(';');
}

/**
 * Keyframe thinning parameters. The dominant contributor to replay size is per-tick position
 * sync; most movement is constant-velocity straight-line walking — so we only record inflection
 * points and endpoints, and let the dumb player recover intermediate positions via per-tick
 * linear interpolation (§7).
 */
/** Collinearity tolerance (cells): if the true position at a given tick differs from the position
 *  predicted by linear interpolation between the surrounding keyframes by less than this value,
 *  that tick may be omitted. Leaves headroom above the 0.01 quantization precision; invisible to the viewer. */
const POS_KEYFRAME_EPS = 0.06;
/** Maximum gap between position keyframes (ticks): beyond this a keyframe is forced, bounding interpolation error accumulation and encoding cost. */
const MAX_KEYFRAME_GAP = 90;

/** Position interpolation model used by the dumb player: linear interpolation between adjacent
 *  keyframes a→b by tick. This function computes the restoration error for an intermediate sample k
 *  (the larger of the col/row absolute errors), used to decide whether k can be omitted. Requires b.tick > a.tick. */
function interpError(
  a: { tick: number; col: number; row: number },
  b: { tick: number; col: number; row: number },
  k: { tick: number; col: number; row: number },
): number {
  const f = (k.tick - a.tick) / (b.tick - a.tick);
  const ic = a.col + (b.col - a.col) * f;
  const ir = a.row + (b.row - a.row) * f;
  return Math.max(Math.abs(k.col - ic), Math.abs(k.row - ir));
}

/**
 * Per-tick samples for the full lifetime of one unit → the set of ticks that must be kept as keyframes.
 * Retention criteria: ① first frame (unit appears) ② last frame (final position before disappearance,
 * preserving movement right before death) ③ static-field transition frame (the inflection point just
 * before it, plus the transition frame itself, so the state flips at exactly the right tick) ④ position
 * inflection (linear-interpolation restoration error exceeds EPS) ⑤ forced frame when gap exceeds MAX_KEYFRAME_GAP.
 */
function keptTicksForUnit(samples: { tick: number; u: StateUnit }[]): Set<number> {
  const keep = new Set<number>();
  const n = samples.length;
  if (n === 0) return keep;
  keep.add(samples[0]!.tick);
  let anchor = 0; // start of the current segment (most recent keyframe)
  for (let i = 1; i < n; i++) {
    const staticChanged = staticSig(samples[i]!.u) !== staticSig(samples[anchor]!.u);
    const gapTooBig = samples[i]!.tick - samples[anchor]!.tick >= MAX_KEYFRAME_GAP;
    let breakHere = staticChanged || gapTooBig;
    if (!breakHere) {
      // Check whether all intermediate samples in the anchor→i segment can be recovered by interpolation.
      const a = samples[anchor]!.u, b = samples[i]!.u;
      for (let k = anchor + 1; k < i; k++) {
        const s = samples[k]!;
        if (
          interpError(
            { tick: samples[anchor]!.tick, col: a.col, row: a.row },
            { tick: samples[i]!.tick, col: b.col, row: b.row },
            { tick: s.tick, col: s.u.col, row: s.u.row },
          ) > POS_KEYFRAME_EPS
        ) {
          breakHere = true;
          break;
        }
      }
    }
    if (breakHere) {
      // Close the previous segment at i-1 (the last point still recoverable from anchor→(i-1) / the inflection point).
      keep.add(samples[i - 1]!.tick);
      anchor = i - 1;
      if (staticChanged) {
        // Static transition: also keep the transition frame itself so that state/HP flips at exactly the right tick.
        keep.add(samples[i]!.tick);
        anchor = i;
      }
    }
  }
  keep.add(samples[n - 1]!.tick);
  return keep;
}

/**
 * Full-frame sequence → delta encoding (keyframe-thinned version).
 *
 * Unlike the old approach of "resend the full record whenever any field changes": units whose
 * position changes every tick are **no longer resent each frame** — keyframes are only emitted at
 * inflection points / endpoints / state transitions, and the dumb player recovers intermediate
 * positions by per-tick linear interpolation ({@link StatePlayerScene} already interpolates this
 * way, so no decoder changes are needed). Empty delta frames are discarded entirely (except the
 * first and last frames, which are always emitted). The dominant size contributor (position sync)
 * is thereby collapsed.
 */
export function encodeStateReplay(full: StateReplay): EncodedStateReplay {
  const src = full.frames;
  if (src.length === 0) return { header: full.header, frames: [] };

  // ── 1. Build per-entity timelines + lifespans (index of first/last appearance frame).
  const unitSamples = new Map<number, { tick: number; u: StateUnit }[]>();
  const unitLastIdx = new Map<number, number>();
  const buildingSamples = new Map<number, { tick: number; b: StateBuilding }[]>();
  const buildingLastIdx = new Map<number, number>();
  src.forEach((f, idx) => {
    for (const u of f.units) {
      let arr = unitSamples.get(u.id);
      if (!arr) unitSamples.set(u.id, (arr = []));
      arr.push({ tick: f.tick, u });
      unitLastIdx.set(u.id, idx);
    }
    for (const b of f.buildings) {
      let arr = buildingSamples.get(b.id);
      if (!arr) buildingSamples.set(b.id, (arr = []));
      arr.push({ tick: f.tick, b });
      buildingLastIdx.set(b.id, idx);
    }
  });

  // ── 2. Per entity: compute the keyframe tick set + removal tick (tick of the frame after the last frame; omit if none).
  const tickAfter = (idx: number): number | null => (idx + 1 < src.length ? src[idx + 1]!.tick : null);
  type UnitPlan = { keep: Set<number>; removeAt: number | null };
  const unitPlans = new Map<number, UnitPlan>();
  for (const [id, samples] of unitSamples) {
    unitPlans.set(id, { keep: keptTicksForUnit(samples), removeAt: tickAfter(unitLastIdx.get(id)!) });
  }
  // Buildings do not move: keyframes on change frames plus first/last frames are sufficient (the dumb player does not interpolate buildings).
  type BuildingPlan = { keep: Set<number>; removeAt: number | null };
  const buildingPlans = new Map<number, BuildingPlan>();
  for (const [id, samples] of buildingSamples) {
    const keep = new Set<number>();
    keep.add(samples[0]!.tick);
    for (let i = 1; i < samples.length; i++) {
      if (buildingSig(samples[i]!.b) !== buildingSig(samples[i - 1]!.b)) keep.add(samples[i]!.tick);
    }
    keep.add(samples[samples.length - 1]!.tick);
    buildingPlans.set(id, { keep, removeAt: tickAfter(buildingLastIdx.get(id)!) });
  }
  // Bases: record the full array whenever any HP changes (very small data volume).
  const basesChangeTicks = new Set<number>();
  let prevBases = '';
  for (const f of src) {
    const sig = basesSig(f.bases);
    if (sig !== prevBases) {
      basesChangeTicks.add(f.tick);
      prevBases = sig;
    }
  }

  // ── 3. Collect the set of ticks that need frames emitted (keyframes ∪ removals ∪ base changes ∪ first/last).
  const emit = new Set<number>([src[0]!.tick, src[src.length - 1]!.tick]);
  for (const p of unitPlans.values()) {
    for (const t of p.keep) emit.add(t);
    if (p.removeAt !== null) emit.add(p.removeAt);
  }
  for (const p of buildingPlans.values()) {
    for (const t of p.keep) emit.add(t);
    if (p.removeAt !== null) emit.add(p.removeAt);
  }
  for (const t of basesChangeTicks) emit.add(t);
  const emitTicks = [...emit].sort((a, b) => a - b);

  // ── 4. Assemble delta frames by tick (discard empty frames; always emit first and last).
  const frameByTick = new Map<number, StateFrame>();
  for (const f of src) frameByTick.set(f.tick, f);
  const bookends = new Set<number>([src[0]!.tick, src[src.length - 1]!.tick]);

  const frames: StateDeltaFrame[] = [];
  for (const tick of emitTicks) {
    const f = frameByTick.get(tick);
    const df: StateDeltaFrame = { tick };

    if (f) {
      const u: StateUnit[] = [];
      for (const su of f.units) {
        if (unitPlans.get(su.id)?.keep.has(tick)) u.push(su);
      }
      if (u.length) df.u = u;
      const b: StateBuilding[] = [];
      for (const sb of f.buildings) {
        if (buildingPlans.get(sb.id)?.keep.has(tick)) b.push(sb);
      }
      if (b.length) df.b = b;
      if (basesChangeTicks.has(tick)) df.bs = f.bases;
    }

    const ru: number[] = [];
    for (const [id, p] of unitPlans) if (p.removeAt === tick) ru.push(id);
    if (ru.length) df.ru = ru;
    const rb: number[] = [];
    for (const [id, p] of buildingPlans) if (p.removeAt === tick) rb.push(id);
    if (rb.length) df.rb = rb;

    const empty = !df.u && !df.ru && !df.b && !df.rb && !df.bs;
    if (!empty || bookends.has(tick)) frames.push(df);
  }

  return { header: full.header, frames };
}

/**
 * Delta encoding → full-frame sequence (consumed by the dumb player).
 *
 * ⚠️ Key point: after keyframe thinning, each unit only has frames at its own inflection points /
 * state transitions, while the global delta-frame sequence is **dense** due to the interleaving of
 * many units — a given unit has **no data** in the frames (belonging to other units) between its
 * two keyframes. If those gaps were filled by "carry-forward" (keeping the last keyframe value
 * unchanged, as the old version did), the unit would stand still and then snap to the next keyframe
 * position, producing field-wide teleporting across multiple units (measured position error of
 * several cells in practice).
 * Therefore, decoding must linearly interpolate each unit's position **between its own adjacent
 * keyframes** (consistent with the tick-interpolation model in {@link StatePlayerScene}), skipping
 * the intervening frames that belong to other units. Static fields (type/side/hp/maxHp/state)
 * switch discretely at keyframes and carry forward in between.
 *
 * The output is still one full-state snapshot per delta-frame tick; the player then sub-interpolates
 * between adjacent snapshots by wall-clock time (piecewise-linear, accurate).
 */
export function decodeStateReplay(enc: EncodedStateReplay): StateReplay {
  const dframes = enc.frames;
  if (dframes.length === 0) return { header: enc.header, frames: [] };

  // ── pass 1: collect each entity's keyframe track (ascending tick) + removal tick; base timeline.
  const unitKf = new Map<number, { tick: number; u: StateUnit }[]>();
  const unitRemoveAt = new Map<number, number>();
  const buildingKf = new Map<number, { tick: number; b: StateBuilding }[]>();
  const buildingRemoveAt = new Map<number, number>();
  const baseTimeline: { tick: number; bases: StateBase[] }[] = [];
  for (const df of dframes) {
    if (df.u) for (const u of df.u) {
      let arr = unitKf.get(u.id);
      if (!arr) unitKf.set(u.id, (arr = []));
      arr.push({ tick: df.tick, u });
    }
    if (df.ru) for (const id of df.ru) unitRemoveAt.set(id, df.tick);
    if (df.b) for (const b of df.b) {
      let arr = buildingKf.get(b.id);
      if (!arr) buildingKf.set(b.id, (arr = []));
      arr.push({ tick: df.tick, b });
    }
    if (df.rb) for (const id of df.rb) buildingRemoveAt.set(id, df.tick);
    if (df.bs) baseTimeline.push({ tick: df.tick, bases: df.bs });
  }

  // ── pass 2: reconstruct full state for each delta-frame tick. Ticks are monotonically increasing; advance each entity cursor in order.
  const unitPtr = new Map<number, number>();
  const buildingPtr = new Map<number, number>();
  let basePtr = -1;
  let bases: StateBase[] = [];

  const frames: StateFrame[] = dframes.map((df) => {
    const T = df.tick;

    // Bases: step-hold carry-forward (take the last full array whose tick ≤ T).
    while (basePtr + 1 < baseTimeline.length && baseTimeline[basePtr + 1]!.tick <= T) {
      basePtr++;
      bases = baseTimeline[basePtr]!.bases;
    }

    const units: StateUnit[] = [];
    for (const [id, kf] of unitKf) {
      if (kf[0]!.tick > T) continue; // not yet spawned
      const removeAt = unitRemoveAt.get(id);
      if (removeAt !== undefined && T >= removeAt) continue; // already removed
      let p = unitPtr.get(id) ?? 0;
      while (p + 1 < kf.length && kf[p + 1]!.tick <= T) p++;
      unitPtr.set(id, p);
      const a = kf[p]!;
      const b = p + 1 < kf.length ? kf[p + 1]! : null;
      if (!b) {
        units.push({ ...a.u });
      } else {
        // Position: linearly interpolated by tick between the unit's own adjacent keyframes a→b; static fields taken from a (they switch only at keyframes).
        const frac = (T - a.tick) / (b.tick - a.tick);
        units.push({ ...a.u, col: a.u.col + (b.u.col - a.u.col) * frac, row: a.u.row + (b.u.row - a.u.row) * frac });
      }
    }
    units.sort((x, y) => x.id - y.id);

    const buildings: StateBuilding[] = [];
    for (const [id, kf] of buildingKf) {
      if (kf[0]!.tick > T) continue;
      const removeAt = buildingRemoveAt.get(id);
      if (removeAt !== undefined && T >= removeAt) continue;
      let p = buildingPtr.get(id) ?? 0;
      while (p + 1 < kf.length && kf[p + 1]!.tick <= T) p++;
      buildingPtr.set(id, p);
      buildings.push({ ...kf[p]!.b }); // buildings do not move: carry-forward is sufficient
    }
    buildings.sort((x, y) => x.id - y.id);

    return { tick: T, units, buildings, bases: bases.map((x) => ({ ...x })) };
  });

  return { header: enc.header, frames };
}
