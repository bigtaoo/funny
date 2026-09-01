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
 * **A SEPARATE file rather than more rules in `audioAssets.test.ts`, and that is the compliance
 * decision, not a filing decision.** Every SFX source is CC0 and needs no attribution;
 * `checkPacks` there asserts exactly that, and `packs.json` carries a top-level
 * `all_sources_commercial_ok_without_attribution: true`. The two BGM tracks are **Suno-generated
 * and NOT CC0**. Filing them into `packs.json` would leave only two outcomes, and both are bad:
 * the CC0 assertion goes red, or somebody "fixes" it by weakening the assertion — and a weakened
 * assertion is worse than no assertion, because the claim it makes about the other 22 files
 * silently stops being checked. So the music record lives in its own `music` / `music_terms`
 * sections of `credits.json`, deliberately outside `packs.json`, and `checkNotInPacks` below
 * asserts that separation holds in BOTH directions.
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
/** `generator` value marking a master the project owns rather than one a service produced.
 *  It is what switches `checkReproducible` and `checkTerms` between their two shapes. */
const FIRST_PARTY = 'first-party';

interface MusicCredit {
  track: string;
  file: string;
  source: string;
  generator: string;
  generated: string;
  brief: string;
  /** The verbatim style prompt for a GENERATED master; `null` for a first-party one, whose
   *  reproducibility record is the master file itself — see `checkReproducible`. */
  prompt: string | null;
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
interface MusicTerms {
  license: string;
  generator: string;
  terms_url: string;
  license_text_archived: boolean;
  accepted_by: string;
  accepted_on: string;
  note: string;
}
interface Credits {
  cues: { files: { file: string }[] }[];
  music: MusicCredit[];
  music_terms: MusicTerms;
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
  // An orphan ships bytes whose licence nobody can explain — which for a NOT-CC0 source is the
  // one direction that actually matters legally.
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
    if (!m.generator) out.push(`${track}: no generator named — the licence hangs off this`);
    if ((m.rationale ?? '').length < MIN_RATIONALE) out.push(`${track}: rationale is a placeholder`);
    if ((m.brief ?? '').length < MIN_RATIONALE) out.push(`${track}: brief is a placeholder`);
  }
  for (const m of ctx.credits.music) {
    if (!(m.track in ctx.files)) out.push(`${m.track}: credited but no track ships it`);
  }
  return out;
}

function checkReproducible(ctx: Ctx): string[] {
  // **One requirement, two shapes, chosen by provenance.** A shipped loop is a REGION of a master
  // — so "can somebody produce this file again" only has an answer if the master is recoverable,
  // and what "recoverable" means differs:
  //
  //  * A generated master exists only as a prompt. daydayup shipped two tracks whose prompts were
  //    never captured; its credits.json carries two `prompt_note` fields explaining the gap was
  //    RECORDED rather than reconstructed, because a reconstructed prompt is a guess that reads
  //    like a record. Archiving the prompt is step 4 of `art/audio/suno/BRIEFS.md` for that reason.
  //  * A first-party master is a FILE, and the corresponding requirement is that the file is in
  //    the repo. `bgm.lobby`'s is (`art/audio/sources/first-party/doodle-bed.flac`, lossless, so it
  //    IS the master); demanding a prompt for it would gate a field that can only be filled with
  //    a fiction, which is the failure mode this rule was written against in the first place.
  //
  // Either way the check is on the artefact that would actually be needed, and neither branch can
  // be satisfied by prose.
  const out: string[] = [];
  for (const m of ctx.credits.music) {
    if (m.generator === FIRST_PARTY) {
      if (!m.source) { out.push(`${m.track}: no source master named`); continue; }
      if (!ctx.masterExists(m.source)) {
        out.push(`${m.track}: the master ${m.source} is not in the repo — the shipped loop is a `
          + 'region of it and cannot be re-cut without it');
      }
      continue;
    }
    if (!m.prompt || m.prompt.trim().length < MIN_RATIONALE) {
      out.push(`${m.track}: the generation prompt is not archived — it is unreproducible without it`);
    }
  }
  return out;
}

function checkTerms(ctx: Ctx): string[] {
  const t = ctx.credits.music_terms;
  const out: string[] = [];
  if (!t) return ['credits.json: no music_terms section'];
  // The point of this rule is that the record stays HONEST about not being CC0. A future edit that
  // quietly relabels it inherits the SFX set's "commercial use, no attribution" claim without
  // anybody re-reading a licence.
  if (/cc0|public.?domain/i.test(t.license)) {
    out.push(`music_terms.license "${t.license}" claims CC0 — AI-generated output is not`);
  }
  if (!/not cc0/i.test(t.note ?? '')) out.push('music_terms.note no longer says NOT CC0 in plain words');
  // `terms_url` points at somebody else's terms, so it is required exactly when there IS somebody
  // else. For a project-owned master there is no third party to have accepted terms with, and a
  // URL invented to satisfy a gate is worse than an empty field — but `accepted_by`/`accepted_on`
  // stay required either way: "who put this in the repo, when" is the half of the record that is
  // load-bearing for a track that is not CC0.
  const required = t.generator === FIRST_PARTY
    ? (['generator', 'accepted_by', 'accepted_on'] as const)
    : (['generator', 'terms_url', 'accepted_by', 'accepted_on'] as const);
  for (const k of required) {
    if (!t[k]) out.push(`music_terms.${k} is empty — who accepted what, when, is the whole record`);
  }
  return out;
}

function checkNotInPacks(ctx: Ctx): string[] {
  const out: string[] = [];
  const shipped = new Set(Object.values(ctx.files));
  for (const p of ctx.packs.packs) {
    for (const f of p.files ?? []) {
      if (shipped.has(basename(f))) {
        out.push(`${f}: a NOT-CC0 track is filed under packs.json's CC0 sources`);
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
  checkGain, checkCredits, checkReproducible, checkTerms, checkNotInPacks, checkNaming,
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
  };
}

describe('the shipped BGM set', () => {
  const ctx = realCtx();
  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name} finds nothing wrong`, () => {
      expect(rule(ctx)).toEqual([]);
    });
  }

  it('ships exactly the one track that has a master', () => {
    // Not decoration: `MusicTrack` is a union whose comment explains why `bgm.battle`,
    // `bgm.intro` and the two result "tracks" are deliberately absent — the first because its
    // master does not exist yet and a fileless track is indistinguishable from a screen that is
    // meant to be quiet. A second member appearing without that comment being revisited is the
    // shape of an unconsidered addition; when `bgm.battle` genuinely lands, this line and the
    // three `music: null` declarations move together.
    expect([...ALL_TRACKS].sort()).toEqual(['bgm.lobby'] satisfies MusicTrack[]);
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

  it('checkReproducible: a first-party master that is not in the repo', () => {
    // The shipped loop is a 74 s REGION of a 3:33 master. Lose the master and it cannot be
    // re-cut — a different region, a different level, a different seam. Nothing else here would
    // notice: the mp3 on disk keeps passing every other rule in this file.
    const c = mutable();
    c.masterExists = () => false;
    fails(checkReproducible, c, 'is not in the repo');
  });

  it('checkReproducible: the daydayup gap, reintroduced (a GENERATED master with no prompt)', () => {
    // The other branch of the same rule. It is unreachable today (the one shipped track is
    // first-party), so the mutation has to supply the provenance as well as the gap — which is
    // the point: `bgm.battle` will arrive on this branch, and the rule must already be armed.
    const c = mutable();
    c.credits.music[0]!.generator = 'Suno v4';
    c.credits.music[0]!.prompt = null;
    fails(checkReproducible, c, 'not archived');
  });

  it('checkTerms: the music record relabelled as CC0', () => {
    const c = mutable();
    c.credits.music_terms.license = 'cc0';
    fails(checkTerms, c, 'claims CC0');
  });

  it('checkTerms: the plain-words NOT CC0 note removed', () => {
    const c = mutable();
    c.credits.music_terms.note = 'Fine for commercial use.';
    fails(checkTerms, c, 'NOT CC0');
  });

  it('checkTerms: nobody recorded as having accepted the terms', () => {
    const c = mutable();
    c.credits.music_terms.accepted_by = '';
    fails(checkTerms, c, 'accepted_by');
  });

  it('checkNotInPacks: a NOT-CC0 track filed into the CC0 pack list', () => {
    const c = mutable();
    c.packs.packs = [...c.packs.packs, { name: 'suno', files: [Object.values(c.files)[0]!] }];
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
