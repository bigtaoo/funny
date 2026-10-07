/**
 * musicAssets.test.ts — holds the shipped BGM files, `art/audio/credits.json`'s music record,
 * `musicCatalogue.ts` and `tools/audio-pipeline/audit.py` to each other.
 *
 * Sibling of `audioAssets.test.ts`, same reasoning (the Python pipeline is deliberately not in CI,
 * so everything it establishes has to be re-checkable by something that runs every commit) and the
 * same shape: **pure `(ctx) => string[]` rules over an injected snapshot, then a mutation suite**.
 * A gate nobody has seen fail is not a gate — and §0.4 records this repo re-learning that the
 * expensive way on the cue gate, whose first version had two rules that turned out to be
 * unreachable once a mutation suite was finally written.
 *
 * **A SEPARATE file rather than more rules in `audioAssets.test.ts`, and a separate record rather
 * than more entries in `packs.json`** — even though every BGM master is CC0 too (FreePD, since
 * 2026-10-07). `packs.json` is `write_packs.py`'s record of the packs `process.py` cuts CUES from,
 * and `audioAssets.test.ts` holds the cue set to it; music is cut by a different driver
 * (`process_music.py`) into a different directory under a different gate. One record describing
 * two pipelines is how a check on one of them quietly stops covering the other. So the music
 * record lives in `credits.json`'s `music` / `music_sources` sections (both written by
 * `process_music.py`), and `checkNotInPacks` below asserts the separation in BOTH directions.
 *
 * **There is no credits screen in this game**, which is what `checkSources` actually guards: a
 * licence that asks for attribution (CC BY and friends) cannot be honoured anywhere a player would
 * see it, so a master under one is refused here rather than shipped on a promise.
 *
 * The check worth reading first: **`lengthS` must still match the file.** `MusicPlayer` starts the
 * next deck at `lengthS - XFADE_S`, so a length that drifts from the shipped audio puts the
 * crossfade somewhere the `xfade_band_diff` gate never measured. Nothing else notices: the file
 * loads, streams, plays, and passes `audit.py`. The only symptom is that the loop stumbles once a
 * minute.
 *
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { ALL_TRACKS, DUCK_CUES, MUSIC_CATALOGUE, XFADE_S } from '../../src/audio/musicCatalogue';
import { CUE_CATALOGUE } from '../../src/audio/cueCatalogue';
import type { MusicTrack } from '../../src/audio/types';

const REPO = join(__dirname, '..', '..', '..');
const MUSIC_DIR = join(__dirname, '..', '..', 'src', 'assets', 'audio', 'music');
const CUE_DIR = join(__dirname, '..', '..', 'src', 'assets', 'audio');
const ART = join(REPO, 'art', 'audio');
const AUDIT_PY = join(REPO, 'tools', 'audio-pipeline', 'audit.py');

/** A rationale shorter than this is a placeholder, and a placeholder is worse than nothing. */
const MIN_RATIONALE = 60;

interface MusicCredit {
  track: string;
  file: string;
  /** The master, repo-relative under `art/audio/sources/`. */
  source: string;
  /** Key into `music_sources` — where the master came from and under what licence. */
  provenance: string;
  title: string;
  author: string;
  /** Where the master's exact bytes were downloaded from. */
  source_url: string;
  /** SPDX id; must equal its `music_sources` entry's. */
  license: string;
  brief: string;
  /** Playback speed the master was re-rendered at before the region was cut (1.0 = as performed).
   *  Part of the cut record, not a note: the master plus the region reproduces the file only at
   *  the speed it was cut at. */
  speed: number;
  region_start_s: number;
  length_s: number;
  source_length_s: number;
  shelf: { hz: number; db: number; order: number } | null;
  sample_rate: number;
  channels: number;
  bytes: number;
  xfade_band_diff_db: number;
  mid_band_dbfs: number;
  rationale: string;
}
interface MusicSource {
  title: string;
  page: string;
  license: string;
  /** Repo-relative path of the archived licence text. */
  license_text: string;
  attribution_required: boolean;
  accepted_by: string;
  accepted_on: string;
  note: string;
}
interface Credits {
  cues: { files: { file: string }[] }[];
  music: MusicCredit[];
  music_sources: Record<string, MusicSource>;
}
interface Packs {
  all_sources_commercial_ok_without_attribution: boolean;
  packs: { files?: string[]; name?: string }[];
}

/** Measured straight out of the MPEG frames — no decoder, no dependency. */
export interface Mp3Info {
  sampleRate: number;
  channels: number;
  frames: number;
  seconds: number;
  kbps: number;
}

/** Everything the rules read. Injected so a mutation can hand them a broken copy. */
interface Ctx {
  credits: Credits;
  packs: Packs;
  /** track id -> the basename `musicCatalogue.ts` ships for it. */
  files: Record<string, string>;
  /** track id -> its `lengthS` / `gain`. */
  defs: Record<string, { lengthS: number; gain: number }>;
  /** Basenames present in `client/src/assets/audio/music/`. */
  onDisk: readonly string[];
  /** Basenames present one level up, i.e. the cue set. */
  cuesOnDisk: readonly string[];
  info(name: string): Mp3Info | null;
  xfadeTs: number;
  /** `XFADE_S` as `audit.py` declares it, or null if it could not be read. */
  xfadePy: number | null;
  /** The `music` gate's numeric window for a field, from `audit.py`. */
  gateWindow(field: string): { lo: number | null; hi: number | null } | null;
  duckCues: readonly string[];
  knownCues: readonly string[];
  /** Is this `source` (repo-relative under `art/audio/sources/`) actually in the repo? */
  masterExists(source: string): boolean;
  /** Is this repo-relative path (an archived licence text) actually in the repo? */
  repoFileExists(path: string): boolean;
}

/**
 * Walk the MPEG frames and report what the stream actually is.
 *
 * A superset of `audioAssets.test.ts`'s `mp3SampleRate`, and deliberately NOT shared with it: that
 * one answers a single question about a 43 ms cue and is quoted verbatim in its own cases, while
 * this one has to count every frame in a 60 s bed to get a duration. Merging them would put a
 * loop over ~2300 frames in the path of 22 files that do not need it, and would couple two gates
 * that fail for different reasons. Both are test-local for the same reason: nothing in the game
 * parses MP3 headers, and adding a production parser so a test can call it is the worse trade.
 */
export function mp3Info(bytes: Buffer): Mp3Info | null {
  let i = 0;
  if (bytes.length > 10 && bytes.toString('latin1', 0, 3) === 'ID3') {
    i = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  }
  const RATES: Record<number, readonly number[]> = {
    3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000],
  };
  // Layer III only, which is all this pipeline emits.
  const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
  let frames = 0, samples = 0, bits = 0, sampleRate = 0, channels = 0;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) { i++; continue; }
    const version = (bytes[i + 1]! >> 3) & 0x03;
    const layer = (bytes[i + 1]! >> 1) & 0x03;
    const brIdx = (bytes[i + 2]! >> 4) & 0x0f;
    const rateIdx = (bytes[i + 2]! >> 2) & 0x03;
    const pad = (bytes[i + 2]! >> 1) & 0x01;
    const mode = (bytes[i + 3]! >> 6) & 0x03;
    if (layer !== 1 || version === 1 || rateIdx === 3 || brIdx === 0 || brIdx === 15) { i++; continue; }
    const sr = RATES[version]![rateIdx]!;
    const kbps = (version === 3 ? BITRATES_V1 : BITRATES_V2)[brIdx]!;
    const spf = version === 3 ? 1152 : 576;
    const len = Math.floor((version === 3 ? 144 : 72) * kbps * 1000 / sr) + pad;
    if (len <= 4) { i++; continue; }
    frames++;
    samples += spf;
    bits += kbps * 1000 * (spf / sr);
    sampleRate = sr;
    channels = mode === 3 ? 1 : 2;
    i += len;
  }
  if (!frames || !sampleRate) return null;
  const seconds = samples / sampleRate;
  return { sampleRate, channels, frames, seconds, kbps: bits / seconds / 1000 };
}

// ── the rules ────────────────────────────────────────────────────────────────────────────────

function checkDiskSet(ctx: Ctx): string[] {
  const out: string[] = [];
  const declared = new Set(Object.values(ctx.files));
  for (const [track, file] of Object.entries(ctx.files)) {
    if (!ctx.onDisk.includes(file)) out.push(`${track}: ${file} is declared but not on disk`);
  }
  // An orphan ships bytes whose licence and provenance nobody recorded.
  for (const f of ctx.onDisk) {
    if (!declared.has(f)) out.push(`${f}: on disk but no track declares it`);
  }
  return out;
}

function checkLength(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const [track, file] of Object.entries(ctx.files)) {
    const info = ctx.info(file);
    if (!info) { out.push(`${file}: not a readable MPEG stream`); continue; }
    const declared = ctx.defs[track]!.lengthS;
    // 0.2 s: MP3 frame padding and encoder delay mean the decoded length is never exactly the
    // region that was cut (`process_music.py` prints both for this reason). A tenth of the 2 s
    // crossfade window is loose enough for that and far tighter than a mistake would be.
    if (Math.abs(info.seconds - declared) > 0.2) {
      out.push(`${track}: lengthS ${declared} but the file measures ${info.seconds.toFixed(3)} s `
        + '— the wrap would land off the seam the gate measured');
    }
    if (declared <= ctx.xfadeTs + 1) {
      out.push(`${track}: lengthS ${declared} leaves no room for a ${ctx.xfadeTs} s crossfade`);
    }
  }
  return out;
}

function checkGateWindow(ctx: Ctx): string[] {
  const out: string[] = [];
  const dur = ctx.gateWindow('duration_ms');
  const kbps = ctx.gateWindow('kbps');
  for (const [track, file] of Object.entries(ctx.files)) {
    const info = ctx.info(file);
    if (!info) continue;
    const ms = info.seconds * 1000;
    if (dur && dur.lo !== null && ms < dur.lo) out.push(`${track}: ${ms.toFixed(0)} ms is under audit.py's floor ${dur.lo}`);
    if (dur && dur.hi !== null && ms > dur.hi) out.push(`${track}: ${ms.toFixed(0)} ms is over audit.py's cap ${dur.hi}`);
    if (kbps && kbps.hi !== null && info.kbps > kbps.hi) {
      out.push(`${track}: ${info.kbps.toFixed(1)} kbps is over audit.py's cap ${kbps.hi}`);
    }
  }
  return out;
}

function checkXfadeShared(ctx: Ctx): string[] {
  // Two files, two languages, no compiler between them — and the number decides both where the
  // player fades and which window the tracks were ACCEPTED on. Changing one alone judges the
  // shipped loops on a window nobody measured.
  if (ctx.xfadePy === null) return ['audit.py: XFADE_S could not be read'];
  return ctx.xfadePy === ctx.xfadeTs ? []
    : [`XFADE_S disagrees: musicCatalogue.ts ${ctx.xfadeTs} vs audit.py ${ctx.xfadePy}`];
}

function checkMidTarget(ctx: Ctx): string[] {
  const win = ctx.gateWindow('mid_band_dbfs');
  if (!win || win.lo === null || win.hi === null) return ["audit.py: the music gate's mid_band_dbfs window could not be read"];
  const out: string[] = [];
  for (const m of ctx.credits.music) {
    if (m.mid_band_dbfs < win.lo || m.mid_band_dbfs > win.hi) {
      out.push(`${m.track}: recorded mid-band ${m.mid_band_dbfs} dBFS is outside the gate's `
        + `[${win.lo}, ${win.hi}] — the bed no longer sits where the cue set was measured against`);
    }
  }
  return out;
}

function checkSeam(ctx: Ctx): string[] {
  const win = ctx.gateWindow('xfade_band_diff');
  if (!win || win.hi === null) return ['audit.py: the xfade_band_diff cap could not be read'];
  return ctx.credits.music
    .filter((m) => m.xfade_band_diff_db > win.hi!)
    .map((m) => `${m.track}: recorded seam ${m.xfade_band_diff_db} dB exceeds the ${win.hi} dB cap`);
}

function checkGain(ctx: Ctx): string[] {
  // The catalogue header states the discipline: level lives in the asset, `gain` is 1.0 for every
  // shipped track. A value other than 1 means somebody adjusted the mix in the SECOND place, and
  // then the -29 dBFS the file carries no longer describes what is heard.
  return Object.entries(ctx.defs)
    .filter(([, d]) => d.gain !== 1)
    .map(([t, d]) => `${t}: gain ${d.gain} — level belongs in the asset, not in a second knob`);
}

function checkCredits(ctx: Ctx): string[] {
  const out: string[] = [];
  const byTrack = new Map(ctx.credits.music.map((m) => [m.track, m]));
  for (const track of Object.keys(ctx.files)) {
    const m = byTrack.get(track);
    if (!m) { out.push(`${track}: no entry in credits.json's music section`); continue; }
    if (m.file !== ctx.files[track]) out.push(`${track}: credits names ${m.file}, catalogue ships ${ctx.files[track]}`);
    if (!m.source) out.push(`${track}: no source master named`);
    if (!m.provenance) out.push(`${track}: no provenance named — the licence hangs off this`);
    for (const k of ['title', 'author', 'source_url', 'license'] as const) {
      if (!m[k]) out.push(`${track}: no ${k} recorded`);
    }
    if ((m.rationale ?? '').length < MIN_RATIONALE) out.push(`${track}: rationale is a placeholder`);
    if ((m.brief ?? '').length < MIN_RATIONALE) out.push(`${track}: brief is a placeholder`);
  }
  for (const m of ctx.credits.music) {
    if (!(m.track in ctx.files)) out.push(`${m.track}: credited but no track ships it`);
  }
  return out;
}

function checkReproducible(ctx: Ctx): string[] {
  // A shipped loop is a REGION of a master, so "can somebody produce this file again" only has
  // an answer if the master itself is in the repo — the original download, byte for byte (its MD5
  // against the source is in the archived licence text). An upstream that has already closed once
  // (FreePD.com, 2025) is not a place to go back to.
  //
  // **The master is only half of it: the other half is what was DONE to it.** The previous lobby
  // bed shipped at 0.7x through a phase vocoder, and a re-cut at the recorded region but the wrong
  // speed is a different track that passes every other rule in this file. So the cut record has
  // to carry the speed — and `length_s`, the one number in that record the shipped bytes can
  // contradict, is checked against them.
  const out: string[] = [];
  for (const m of ctx.credits.music) {
    if (!(m.speed > 0)) {
      out.push(`${m.track}: no playback speed recorded — the master alone does not re-cut the `
        + 'file, and 1.0 has to be a stated decision rather than an absent field');
    }
    const info = ctx.info(m.file);
    if (info && Math.abs(info.seconds - m.length_s) > 0.2) {
      out.push(`${m.track}: credits records a ${m.length_s} s region but the shipped file `
        + `measures ${info.seconds.toFixed(3)} s — the record does not describe these bytes`);
    }
    if (!m.source || !ctx.masterExists(m.source)) {
      out.push(`${m.track}: the master ${m.source} is not in the repo — the shipped loop is a `
        + 'region of it and cannot be re-cut without it');
    }
  }
  return out;
}

function checkSources(ctx: Ctx): string[] {
  const sources = ctx.credits.music_sources;
  if (!sources) return ['credits.json: no music_sources section'];
  const out: string[] = [];
  for (const m of ctx.credits.music) {
    const src = sources[m.provenance];
    if (!src) { out.push(`${m.track}: provenance "${m.provenance}" has no music_sources entry`); continue; }
    if (m.license !== src.license) {
      out.push(`${m.track}: records licence ${m.license} but its source is ${src.license}`);
    }
  }
  const used = new Set(ctx.credits.music.map((m) => m.provenance));
  for (const [id, src] of Object.entries(sources)) {
    if (!used.has(id)) out.push(`music_sources.${id}: no track uses it — a licence covering nothing`);
    for (const k of ['license', 'page', 'license_text', 'accepted_by', 'accepted_on'] as const) {
      if (!src[k]) out.push(`music_sources.${id}.${k} is empty — who accepted what, when, is the whole record`);
    }
    if (src.license_text && !ctx.repoFileExists(src.license_text)) {
      out.push(`music_sources.${id}: licence text ${src.license_text} is not in the repo`);
    }
    if (src.attribution_required !== false) {
      out.push(`music_sources.${id}: requires attribution, and this game has no credits screen to carry it`);
    }
  }
  return out;
}

function checkNotInPacks(ctx: Ctx): string[] {
  const out: string[] = [];
  const shipped = new Set(Object.values(ctx.files));
  for (const p of ctx.packs.packs) {
    for (const f of p.files ?? []) {
      if (shipped.has(basename(f))) {
        out.push(`${f}: a music track is filed under packs.json, which records the cue pipeline's sources`);
      }
    }
  }
  // The other direction, and the one that actually protects the other 22 files: the CC0 claim over
  // the SFX pool must still be made, not quietly dropped to make room for the music.
  if (ctx.packs.all_sources_commercial_ok_without_attribution !== true) {
    out.push('packs.json no longer claims its sources are commercial-ok without attribution — '
      + 'that claim covers the SFX set and must not be weakened to accommodate BGM');
  }
  return out;
}

function checkNaming(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const [track, file] of Object.entries(ctx.files)) {
    const want = `${track.replace(/\./g, '-')}.mp3`;
    if (file !== want) out.push(`${track}: ships as ${file}, convention says ${want}`);
    // A music file sitting in the cue directory would be picked up by `audit.py --by-cue`'s NAME
    // routing and held to the combat gate. The directory is what routes it (see `class_for`), so
    // the directories must stay disjoint.
    if (ctx.cuesOnDisk.includes(file)) out.push(`${file}: also present in the cue directory`);
  }
  return out;
}

function checkDuckCues(ctx: Ctx): string[] {
  // A typo'd cue id in `DUCK_CUES` is a `Set` member that nothing ever matches: the bed simply
  // never ducks for that cue, and no type error, no test and no log says so.
  return ctx.duckCues
    .filter((c) => !ctx.knownCues.includes(c))
    .map((c) => `DUCK_CUES contains ${c}, which is not a cue — it can never match`);
}

const RULES = {
  checkDiskSet, checkLength, checkGateWindow, checkXfadeShared, checkMidTarget, checkSeam,
  checkGain, checkCredits, checkReproducible, checkSources, checkNotInPacks, checkNaming,
  checkDuckCues,
};

// ── the real snapshot ────────────────────────────────────────────────────────────────────────

/** `XFADE_S = 2.0` out of audit.py. Read rather than duplicated — duplicating it would create the
 *  very drift this file exists to catch. */
function readXfadePy(src: string): number | null {
  const m = /^XFADE_S\s*=\s*([0-9.]+)/m.exec(src);
  return m ? Number(m[1]) : null;
}

/** One `("field", lo, hi, "why")` row out of audit.py's `music` gate. `None` becomes null. */
function readGateWindow(src: string, field: string): { lo: number | null; hi: number | null } | null {
  const music = /"music":\s*\[([\s\S]*?)\n\s*\],/.exec(src);
  if (!music) return null;
  const row = new RegExp(`\\("${field}",\\s*(None|-?[0-9.]+),\\s*(None|-?[0-9.]+)`).exec(music[1]!);
  if (!row) return null;
  const num = (s: string): number | null => (s === 'None' ? null : Number(s));
  return { lo: num(row[1]!), hi: num(row[2]!) };
}

function realCtx(): Ctx {
  const credits = JSON.parse(readFileSync(join(ART, 'credits.json'), 'utf8')) as Credits;
  const packs = JSON.parse(readFileSync(join(ART, 'packs.json'), 'utf8')) as Packs;
  const py = existsSync(AUDIT_PY) ? readFileSync(AUDIT_PY, 'utf8') : '';
  const files: Record<string, string> = {};
  const defs: Record<string, { lengthS: number; gain: number }> = {};
  for (const t of ALL_TRACKS) {
    const def = MUSIC_CATALOGUE[t];
    // `path` is a webpack-baked URL; only its basename is a fact about the repo.
    files[t] = basename(def.path.split('?')[0]!);
    defs[t] = { lengthS: def.lengthS, gain: def.gain };
  }
  const cache = new Map<string, Mp3Info | null>();
  return {
    credits, packs, files, defs,
    onDisk: existsSync(MUSIC_DIR) ? readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|ogg|wav)$/i.test(f)) : [],
    cuesOnDisk: existsSync(CUE_DIR)
      ? readdirSync(CUE_DIR, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name)
      : [],
    info: (name) => {
      if (!cache.has(name)) {
        const p = join(MUSIC_DIR, name);
        cache.set(name, existsSync(p) ? mp3Info(readFileSync(p)) : null);
      }
      return cache.get(name)!;
    },
    xfadeTs: XFADE_S,
    xfadePy: readXfadePy(py),
    gateWindow: (f) => readGateWindow(py, f),
    duckCues: [...DUCK_CUES],
    knownCues: Object.keys(CUE_CATALOGUE),
    masterExists: (source) => existsSync(join(ART, 'sources', source)),
    repoFileExists: (path) => existsSync(join(REPO, path)),
  };
}

describe('the shipped BGM set', () => {
  const ctx = realCtx();
  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name} finds nothing wrong`, () => {
      expect(rule(ctx)).toEqual([]);
    });
  }

  it('ships exactly the three tracks the design names', () => {
    // Not decoration: `MusicTrack` is a union whose comment explains why `bgm.intro` and the two
    // result "tracks" are deliberately absent, and why §2.3's `bgm.battle` is two tracks split at
    // the x2 ink phase. A fourth member appearing without that comment being revisited is the
    // shape of an unconsidered addition.
    expect([...ALL_TRACKS].sort()).toEqual(
      ['bgm.battle.early', 'bgm.battle.late', 'bgm.lobby'] satisfies MusicTrack[]);
  });
});

// ── the mutation suite ───────────────────────────────────────────────────────────────────────

/** A deep-enough copy that a mutation cannot leak into the real snapshot. */
function mutable(): Ctx {
  const real = realCtx();
  return {
    ...real,
    credits: JSON.parse(JSON.stringify(real.credits)) as Credits,
    packs: JSON.parse(JSON.stringify(real.packs)) as Packs,
    files: { ...real.files },
    defs: Object.fromEntries(Object.entries(real.defs).map(([k, v]) => [k, { ...v }])),
    onDisk: [...real.onDisk],
    cuesOnDisk: [...real.cuesOnDisk],
    duckCues: [...real.duckCues],
    knownCues: [...real.knownCues],
  };
}

describe('every rule has been seen to fail', () => {
  function fails(rule: (c: Ctx) => string[], ctx: Ctx, mentions: string): void {
    const got = rule(ctx);
    expect(got.length, `expected a complaint mentioning "${mentions}", got ${JSON.stringify(got)}`)
      .toBeGreaterThan(0);
    expect(got.join('\n')).toContain(mentions);
  }

  it('checkDiskSet: a declared file that is not on disk', () => {
    const c = mutable();
    c.onDisk = [];
    fails(checkDiskSet, c, 'not on disk');
  });

  it('checkDiskSet: a file on disk that nothing declares', () => {
    const c = mutable();
    c.onDisk = [...c.onDisk, 'bgm-leftover.mp3'];
    fails(checkDiskSet, c, 'no track declares it');
  });

  it('checkLength: a lengthS that drifted from the file', () => {
    const c = mutable();
    const t = Object.keys(c.defs)[0]!;
    c.defs[t]!.lengthS += 3;
    fails(checkLength, c, 'off the seam');
  });

  it('checkLength: a track too short to crossfade at all', () => {
    const c = mutable();
    const t = Object.keys(c.defs)[0]!;
    c.defs[t]!.lengthS = 2.5;
    fails(checkLength, c, 'no room for a');
  });

  it('checkGateWindow: a bed outside audit.py\'s own duration window', () => {
    const c = mutable();
    const t = Object.keys(c.files)[0]!;
    const real = c.info(c.files[t]!);
    c.info = () => ({ ...real!, seconds: 5 });
    fails(checkGateWindow, c, "under audit.py's floor");
  });

  it('checkGateWindow: a bitrate over budget', () => {
    const c = mutable();
    const real = c.info(Object.values(c.files)[0]!);
    c.info = () => ({ ...real!, kbps: 256 });
    fails(checkGateWindow, c, "over audit.py's cap");
  });

  it('checkXfadeShared: the two XFADE_S drifting apart', () => {
    const c = mutable();
    c.xfadePy = 3.0;
    fails(checkXfadeShared, c, 'XFADE_S disagrees');
  });

  it('checkMidTarget: a bed whose level left the window the cue set was measured against', () => {
    const c = mutable();
    c.credits.music[0]!.mid_band_dbfs = -20;
    fails(checkMidTarget, c, 'outside the gate');
  });

  it('checkSeam: a recorded seam over the cap', () => {
    const c = mutable();
    c.credits.music[0]!.xfade_band_diff_db = 9;
    fails(checkSeam, c, 'exceeds the');
  });

  it('checkGain: a second level knob being used', () => {
    const c = mutable();
    c.defs[Object.keys(c.defs)[0]!]!.gain = 0.7;
    fails(checkGain, c, 'not in a second knob');
  });

  it('checkCredits: a shipped track with no record', () => {
    const c = mutable();
    c.credits.music = [];
    fails(checkCredits, c, 'no entry in credits.json');
  });

  it('checkCredits: a record naming a different file than the one that ships', () => {
    const c = mutable();
    c.credits.music[0]!.file = 'audio/music/something-else.mp3';
    fails(checkCredits, c, 'credits names');
  });

  it('checkCredits: a placeholder rationale', () => {
    const c = mutable();
    c.credits.music[0]!.rationale = 'good one';
    fails(checkCredits, c, 'rationale is a placeholder');
  });

  it('checkReproducible: a master that is not in the repo', () => {
    // A shipped loop is a REGION of a longer master. Lose the master and it cannot be re-cut — a
    // different region, a different level, a different seam. Nothing else here would notice: the
    // mp3 on disk keeps passing every other rule in this file.
    const c = mutable();
    c.masterExists = () => false;
    fails(checkReproducible, c, 'is not in the repo');
  });

  it('checkReproducible: a cut record with no speed', () => {
    const c = mutable();
    (c.credits.music[0] as { speed: number }).speed = 0;
    fails(checkReproducible, c, 'no playback speed recorded');
  });

  it('checkReproducible: the region length left at the previous cut', () => {
    // The exact 2026-09-05 near-miss: `speed` went to 0.8 and the region was re-searched, so a
    // `length_s` left at 74 would have described the file that USED to ship while every other
    // number in the record was current.
    const c = mutable();
    c.credits.music[0]!.length_s += 3;
    fails(checkReproducible, c, 'does not describe these bytes');
  });

  it('checkSources: a track whose provenance has no licence entry', () => {
    const c = mutable();
    c.credits.music[0]!.provenance = 'somewhere-else';
    fails(checkSources, c, 'has no music_sources entry');
  });

  it('checkSources: a track recording a different licence than its source', () => {
    const c = mutable();
    c.credits.music[0]!.license = 'CC-BY-4.0';
    fails(checkSources, c, 'but its source is');
  });

  it('checkSources: nobody recorded as having accepted the licence', () => {
    const c = mutable();
    c.credits.music_sources[c.credits.music[0]!.provenance]!.accepted_by = '';
    fails(checkSources, c, 'accepted_by');
  });

  it('checkSources: the archived licence text gone from the repo', () => {
    const c = mutable();
    c.repoFileExists = () => false;
    fails(checkSources, c, 'is not in the repo');
  });

  it('checkSources: a licence that asks for attribution', () => {
    const c = mutable();
    c.credits.music_sources[c.credits.music[0]!.provenance]!.attribution_required = true;
    fails(checkSources, c, 'no credits screen');
  });

  it('checkSources: a licence entry no track uses', () => {
    const c = mutable();
    c.credits.music_sources = { ...c.credits.music_sources, orphan: { ...Object.values(c.credits.music_sources)[0]! } };
    fails(checkSources, c, 'a licence covering nothing');
  });

  it('checkNotInPacks: a music track filed into the cue pipeline\'s pack list', () => {
    const c = mutable();
    c.packs.packs = [...c.packs.packs, { name: 'freepd', files: [Object.values(c.files)[0]!] }];
    fails(checkNotInPacks, c, 'filed under');
  });

  it('checkNotInPacks: the CC0 claim weakened to accommodate the music', () => {
    const c = mutable();
    c.packs.all_sources_commercial_ok_without_attribution = false;
    fails(checkNotInPacks, c, 'must not be weakened');
  });

  it('checkNaming: a track shipped under an off-convention name', () => {
    const c = mutable();
    const t = Object.keys(c.files)[0]!;
    c.files[t] = 'lobby.mp3';
    fails(checkNaming, c, 'convention says');
  });

  it('checkNaming: a bed sitting in the cue directory, where the name routing would gate it wrong',
    () => {
      const c = mutable();
      c.cuesOnDisk = [...c.cuesOnDisk, Object.values(c.files)[0]!];
      fails(checkNaming, c, 'also present in the cue directory');
    });

  it('checkDuckCues: a cue id that can never match', () => {
    const c = mutable();
    c.duckCues = [...c.duckCues, 'sfx.result.victoy'];
    fails(checkDuckCues, c, 'can never match');
  });
});

// ── the parser this all rests on ─────────────────────────────────────────────────────────────

describe('mp3Info', () => {
  /** One synthetic MPEG1 Layer III frame header + its payload, at a known rate/bitrate/mode. */
  function frame(kbpsIdx: number, rateIdx: number, mode: number): Buffer {
    const RATES = [44100, 48000, 32000];
    const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const len = Math.floor(144 * BITRATES[kbpsIdx]! * 1000 / RATES[rateIdx]!);
    const b = Buffer.alloc(len);
    b[0] = 0xff;
    b[1] = 0xfb;                                   // MPEG1, Layer III, no CRC
    b[2] = (kbpsIdx << 4) | (rateIdx << 2);
    b[3] = mode << 6;
    return b;
  }

  it('reads rate, channels and a duration that matches the frame count', () => {
    const one = frame(9, 0, 0);                    // 128 kbps, 44100 Hz, stereo
    const got = mp3Info(Buffer.concat(Array.from({ length: 100 }, () => one)))!;
    expect(got.sampleRate).toBe(44100);
    expect(got.channels).toBe(2);
    expect(got.frames).toBe(100);
    expect(got.seconds).toBeCloseTo(100 * 1152 / 44100, 6);
    expect(got.kbps).toBeCloseTo(128, 0);
  });

  it('reads mono as one channel', () => {
    const got = mp3Info(Buffer.concat(Array.from({ length: 20 }, () => frame(9, 0, 3))))!;
    expect(got.channels).toBe(1);
  });

  it('skips an ID3v2 tag whose body would otherwise look like a sync word', () => {
    const tag = Buffer.alloc(10 + 64, 0xff);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 3; tag[4] = 0; tag[5] = 0;
    tag[6] = 0; tag[7] = 0; tag[8] = 0; tag[9] = 64;
    const got = mp3Info(Buffer.concat([tag, ...Array.from({ length: 10 }, () => frame(9, 0, 0))]))!;
    expect(got.frames).toBe(10);
  });

  it('returns null on something that is not an MPEG stream', () => {
    expect(mp3Info(Buffer.from('not audio at all, not even close'))).toBeNull();
  });
});
