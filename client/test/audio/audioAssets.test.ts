/**
 * audioAssets.test.ts — holds the shipped audio files, `art/audio/credits.json`,
 * `art/audio/packs.json`, `cueAssets.ts` and the live `AudioCue` / `CUE_CATALOGUE` to each other.
 *
 * Why a test and not trust in the pipeline: `tools/audio-pipeline/process.py` is Python and
 * deliberately NOT in CI (that would put a Python toolchain in every build). It runs once per
 * batch of material. Everything it establishes therefore has to be re-checkable by something
 * that does run on every commit — otherwise the invariants decay silently between batches.
 *
 * The one check worth reading before the others: **`catalogue_gain` must still match
 * `CUE_CATALOGUE`.** Every shipped sample was scaled to
 *
 *     file_peak = measured_delivered_peak / (catalogue_gain × bus_gain)
 *
 * so that swapping a synth voice for a sample does not change that cue's weight in the mix
 * (AUDIO_DESIGN §4). Edit a gain in `cueCatalogue.ts` and the arithmetic behind 22 files on disk
 * quietly stops holding — the cue gets louder or quieter than the design says, and NOTHING else
 * fails: the files still load, still play, still pass every unit test, and the only symptom is a
 * mix that drifted. That is the class of defect this file exists for.
 *
 * **Shape: pure checks over an injected snapshot, then a mutation suite.** Every rule is a
 * `(ctx) => string[]` returning the problems it found, so the same rule can be run against the
 * real repo (expect `[]`) and against a deliberately broken copy (expect a specific complaint).
 * The repo already learned this lesson today in `scripts/checkWechatPackage.mjs`, whose `--pkg`
 * flag exists for exactly this reason: **a gate nobody has seen fail is not a gate.** The first
 * version of this file had no mutation suite, and two of its rules turned out to be unreachable
 * when one was finally written (see `checkVariantMapping` and `checkSourceUniqueness` — both are
 * NEW here, and both close holes the original nine cases could not see).
 *
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { basename, join } from 'path';
import { ALL_CUES, CUE_CATALOGUE } from '../../src/audio/cueCatalogue';
import { CUE_ASSETS } from '../../src/audio/cueAssets';
import type { AudioCue } from '../../src/audio/types';

const AUDIO_DIR = join(__dirname, '..', '..', 'src', 'assets', 'audio');
const ART = join(__dirname, '..', '..', '..', 'art', 'audio');
const REPO = join(__dirname, '..', '..', '..');

/** The SFX bus gain the delivered peaks were measured at — `DEFAULT_AUDIO_SETTINGS` master×sfx. */
const BUS_GAIN = 0.8;
/** A rationale shorter than this is a placeholder, and a placeholder is worse than nothing. */
const MIN_RATIONALE = 60;

interface CreditFile {
  file: string;
  source: string;
  source_pack: string;
  sample_rate: number;
  duration_ms: number;
  bytes: number;
  gain_applied_db: number;
}
interface CreditCue {
  cue: string;
  variants: number;
  gate_class: string;
  target_delivered_peak: number;
  catalogue_gain: number;
  target_file_peak: number;
  cap_ms: number;
  rationale: string;
  files: CreditFile[];
}
interface Credits {
  bus_gain_measured_at: number;
  cues: CreditCue[];
  kept_on_synth: Record<string, string>;
}
interface Pack {
  id: string;
  license: string;
  license_text: string | null;
  attribution_required: boolean;
  sounds?: { file: string; license: string }[];
}
interface Packs {
  all_sources_commercial_ok_without_attribution: boolean;
  packs: Pack[];
}

/** Everything the rules read. Injected so a mutation can hand them a broken copy. */
interface Ctx {
  credits: Credits;
  packs: Packs;
  /** cue id -> shipped urls, as `cueAssets.ts` declares them. */
  urls: Record<string, readonly string[]>;
  /** Audio filenames present in `client/src/assets/audio/`. */
  onDisk: readonly string[];
  /** Byte length + MPEG-header sample rate of a shipped file, or null if it is not there. */
  file(name: string): { bytes: number; sampleRate: number | null } | null;
  /** `CUE_CATALOGUE[cue].gain`, or undefined for a cue outside the union. */
  catalogueGain(cue: string): number | undefined;
  allCues: readonly string[];
  /** Contents of a repo-relative licence text file, or null if it is missing. */
  licenceText(relPath: string): string | null;
}

/**
 * Sample rate straight out of the first MPEG audio frame header — no decoder, no dependency.
 * Skips an ID3v2 tag if the encoder wrote one, then scans for the 11-bit frame sync.
 *
 * Exported-by-test rather than imported from src on purpose: nothing in the game parses MP3
 * headers, and adding a production parser so a test can call it would be the worse trade. Its own
 * cases live in the `mp3SampleRate` describe block below, because a silently-wrong parser here
 * would make the stream check pass on anything.
 */
export function mp3SampleRate(bytes: Buffer): number | null {
  let i = 0;
  if (bytes.length > 10 && bytes.toString('latin1', 0, 3) === 'ID3') {
    // ID3v2 size is four 7-bit bytes, big-endian.
    i = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!);
  }
  for (; i + 3 < bytes.length; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1]! & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1]! >> 3) & 0x03;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (bytes[i + 1]! >> 1) & 0x03;     // 1 = Layer III
    const rateIdx = (bytes[i + 2]! >> 2) & 0x03;
    if (layer !== 1 || version === 1 || rateIdx === 3) continue;   // 1 = reserved version
    const table: Record<number, readonly number[]> = {
      3: [44100, 48000, 32000],
      2: [22050, 24000, 16000],
      0: [11025, 12000, 8000],
    };
    return table[version]![rateIdx]!;
  }
  return null;
}

// ── the rules ────────────────────────────────────────────────────────────────────────────────

function checkDiskSet(ctx: Ctx): string[] {
  const declared = new Set(ctx.credits.cues.flatMap((c) => c.files.map((f) => f.file)));
  const out: string[] = [];
  // Both directions: an orphan file ships bytes nobody can explain the licence of, and a file
  // credits.json promises but nobody shipped is a build failure via cueAssets.ts's import — but
  // only once somebody builds.
  for (const f of ctx.onDisk) if (!declared.has(f)) out.push(`orphan on disk: ${f}`);
  for (const f of declared) if (!ctx.onDisk.includes(f)) out.push(`declared but missing: ${f}`);
  return out;
}

function checkSides(ctx: Ctx): string[] {
  const sampled = ctx.credits.cues.map((c) => c.cue);
  const synth = Object.keys(ctx.credits.kept_on_synth);
  const out: string[] = [];
  for (const c of sampled) {
    if (synth.includes(c)) out.push(`${c}: recorded as BOTH sampled and kept-on-synth`);
  }
  const decided = new Set([...sampled, ...synth]);
  for (const c of ctx.allCues) if (!decided.has(c)) out.push(`${c}: no side recorded at all`);
  for (const c of decided) if (!ctx.allCues.includes(c)) out.push(`${c}: not in the AudioCue union`);
  return out;
}

/**
 * **NEW, and the hole the original nine cases could not see.** They checked that a cue has the
 * right NUMBER of variants and that the files exist — never that the cue points at *its own*
 * files. Swap two cues' import arrays in `cueAssets.ts` and every one of those cases stays green
 * while the game plays the wrong sound for both.
 *
 * Depends on the test environment: under vitest an `import x from './y.mp3'` resolves to the
 * source path (`/src/assets/audio/y.mp3`), so the basename is recoverable. Under webpack it
 * resolves to `<CDN>/cdn/<contenthash>.mp3` and carries no filename at all — which is the whole
 * reason `cueAssets.ts` uses explicit imports (see its header). If the vitest config ever grows a
 * hashing asset transform this check goes blind: fix it then, do not delete it.
 */
function checkVariantMapping(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const c of ctx.credits.cues) {
    const urls = ctx.urls[c.cue];
    if (!urls) {
      out.push(`${c.cue}: credits.json ships ${c.variants} variant(s), cueAssets.ts has none`);
      continue;
    }
    if (urls.length !== c.variants) {
      out.push(`${c.cue}: cueAssets.ts has ${urls.length} url(s), credits.json says ${c.variants}`);
    }
    const got = urls.map((u) => basename(u));
    const want = c.files.map((f) => f.file);
    if (got.join(',') !== want.join(',')) {
      out.push(`${c.cue}: cueAssets.ts imports [${got.join(', ')}] but credits.json declares `
        + `[${want.join(', ')}] — a cue is pointing at another cue's recordings`);
    }
  }
  for (const cue of Object.keys(ctx.credits.kept_on_synth)) {
    if (ctx.urls[cue]) out.push(`${cue}: recorded as kept-on-synth but cueAssets.ts ships urls`);
  }
  return out;
}

function checkPeakReference(ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.credits.bus_gain_measured_at !== BUS_GAIN) {
    out.push(`bus gain drifted: credits.json says ${ctx.credits.bus_gain_measured_at}, `
      + `audioSettings' default is ${BUS_GAIN}`);
  }
  for (const c of ctx.credits.cues) {
    const live = ctx.catalogueGain(c.cue);
    if (live !== c.catalogue_gain) {
      out.push(`${c.cue}: cueCatalogue.ts gain is ${live}, samples were peak-matched against `
        + `${c.catalogue_gain} — re-run tools/audio-pipeline/process.py`);
    }
    const expected = c.target_delivered_peak / (c.catalogue_gain * ctx.credits.bus_gain_measured_at);
    if (Math.abs(c.target_file_peak - expected) > 5e-5) {
      out.push(`${c.cue}: target_file_peak ${c.target_file_peak} != delivered/(gain*bus) `
        + `= ${expected.toFixed(5)}`);
    }
  }
  return out;
}

function checkStreams(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const c of ctx.credits.cues) {
    for (const f of c.files) {
      const got = ctx.file(f.file);
      if (!got) { out.push(`${f.file}: not on disk`); continue; }
      if (got.bytes !== f.bytes) {
        out.push(`${f.file}: ${got.bytes} bytes on disk, credits.json says ${f.bytes}`);
      }
      if (got.sampleRate !== f.sample_rate) {
        out.push(`${f.file}: MPEG header says ${got.sampleRate} Hz, credits.json says `
          + `${f.sample_rate} Hz`);
      }
    }
  }
  return out;
}

function checkCaps(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const c of ctx.credits.cues) {
    for (const f of c.files) {
      if (!(f.duration_ms > 0)) out.push(`${f.file}: duration ${f.duration_ms} ms`);
      // +1 ms of slack: the cap is applied in samples, so the ms figure rounds.
      if (f.duration_ms > c.cap_ms + 1) {
        out.push(`${f.file}: ${f.duration_ms} ms outlasts ${c.cue}'s ${c.cap_ms} ms cap`);
      }
    }
  }
  return out;
}

/**
 * **NEW.** Two cues built from the same recording would sound like the same event at two
 * lengths — which is exactly the slip that nearly happened here: `stroke_632474.ogg` was a strong
 * candidate for both `sfx.card.play` (a stroke) and `sfx.unit.attack` (a jab), and shipping it as
 * both would have made a pencil jab indistinguishable from playing a card. It ended up on
 * `unit.attack` alone. If a future batch genuinely wants one source in two cues, this is the
 * place to say so out loud rather than the place to discover it by ear.
 */
function checkSourceUniqueness(ctx: Ctx): string[] {
  const owner = new Map<string, string>();
  const out: string[] = [];
  for (const c of ctx.credits.cues) {
    for (const f of c.files) {
      const prev = owner.get(f.source);
      if (prev !== undefined && prev !== c.cue) {
        out.push(`${f.source} feeds both ${prev} and ${c.cue}`);
      }
      owner.set(f.source, c.cue);
    }
  }
  return out;
}

function checkPacks(ctx: Ctx): string[] {
  const out: string[] = [];
  if (ctx.packs.all_sources_commercial_ok_without_attribution !== true) {
    out.push('packs.json no longer claims every source is commercial-ok without attribution');
  }
  const byId = new Map(ctx.packs.packs.map((p) => [p.id, p]));
  const used = new Set(ctx.credits.cues.flatMap((c) => c.files.map((f) => f.source_pack)));
  for (const id of used) {
    const pack = byId.get(id);
    if (!pack) { out.push(`credits.json ships from '${id}' but packs.json does not declare it`); continue; }
    if (!/CC0/.test(pack.license)) out.push(`${id}: licence is '${pack.license}', not CC0`);
    if (pack.attribution_required !== false) out.push(`${id}: attribution_required is not false`);
  }
  // freesound's licence is per SOUND, not per pack, so the pack row alone proves nothing.
  const fs = byId.get('freesound');
  if (fs) {
    const recorded = new Map((fs.sounds ?? []).map((s) => [s.file, s]));
    const usedFromFs = ctx.credits.cues
      .flatMap((c) => c.files)
      .filter((f) => f.source_pack === 'freesound')
      .map((f) => f.source.split('/')[1]!);
    for (const file of usedFromFs) {
      const s = recorded.get(file);
      if (!s) { out.push(`no per-sound licence record for freesound/${file}`); continue; }
      if (s.license !== 'http://creativecommons.org/publicdomain/zero/1.0/') {
        out.push(`freesound/${file}: licence is '${s.license}', not CC0`);
      }
    }
  }
  return out;
}

function checkLicenceTexts(ctx: Ctx): string[] {
  const out: string[] = [];
  for (const pack of ctx.packs.packs) {
    if (!pack.license_text) continue;
    const text = ctx.licenceText(pack.license_text);
    if (text === null) {
      out.push(`${pack.id}: ${pack.license_text} is declared but missing`);
    } else if (!/CC0/.test(text)) {
      out.push(`${pack.id}: ${pack.license_text} does not mention CC0`);
    }
  }
  return out;
}

function checkRationales(ctx: Ctx): string[] {
  const out: string[] = [];
  // Both halves of the record are load-bearing: `rationale` is why THIS family was picked, and
  // `kept_on_synth` is why a cue has no files at all. Without the second, an empty entry in
  // cueAssets.ts is indistinguishable from an oversight, which is the exact state this whole step
  // was in for three rounds.
  for (const c of ctx.credits.cues) {
    if (c.rationale.length <= MIN_RATIONALE) out.push(`${c.cue}: rationale is a placeholder`);
  }
  for (const [cue, why] of Object.entries(ctx.credits.kept_on_synth)) {
    // A cross-reference is allowed where several cues share one reason — the three gacha reveal
    // tiers are one decision about a relationship between them, and stating it three times would
    // make the record worse, not better. But the pointer has to RESOLVE: a dangling
    // "See `sfx.something`" is exactly the placeholder this test is looking for.
    const ref = /^See `([^`]+)`\.$/.exec(why);
    if (ref) {
      const target = ref[1]!;
      const to = ctx.credits.kept_on_synth[target];
      if (target === cue) out.push(`${cue}: cross-references itself`);
      else if (to === undefined) out.push(`${cue}: cross-references ${target}, which has no entry`);
      else if (to.length <= MIN_RATIONALE) out.push(`${cue} -> ${target}: target is a placeholder`);
      continue;
    }
    if (why.length <= MIN_RATIONALE) out.push(`${cue}: kept_on_synth reason is a placeholder`);
  }
  return out;
}

const RULES = {
  diskSet: checkDiskSet,
  sides: checkSides,
  variantMapping: checkVariantMapping,
  peakReference: checkPeakReference,
  streams: checkStreams,
  caps: checkCaps,
  sourceUniqueness: checkSourceUniqueness,
  packs: checkPacks,
  licenceTexts: checkLicenceTexts,
  rationales: checkRationales,
} as const;

// ── the real snapshot ────────────────────────────────────────────────────────────────────────

function realCtx(): Ctx {
  const credits: Credits = JSON.parse(readFileSync(join(ART, 'credits.json'), 'utf8'));
  const packs: Packs = JSON.parse(readFileSync(join(ART, 'packs.json'), 'utf8'));
  const onDisk = readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|wav|ogg)$/i.test(f)).sort();
  const urls: Record<string, readonly string[]> = {};
  for (const [cue, list] of Object.entries(CUE_ASSETS)) if (list) urls[cue] = list;
  return {
    credits,
    packs,
    urls,
    onDisk,
    file(name) {
      const p = join(AUDIO_DIR, name);
      if (!existsSync(p)) return null;
      const buf = readFileSync(p);
      return { bytes: buf.length, sampleRate: mp3SampleRate(buf) };
    },
    catalogueGain: (cue) => CUE_CATALOGUE[cue as AudioCue]?.gain,
    allCues: ALL_CUES,
    licenceText: (rel) => {
      const p = join(REPO, rel);
      return existsSync(p) ? readFileSync(p, 'utf8') : null;
    },
  };
}

const REAL = realCtx();

describe('shipped audio assets', () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`${name}: no problems in the shipped set`, () => {
      expect(rule(REAL)).toEqual([]);
    });
  }

  it('ships the set AUDIO_DESIGN §0.4 records — 10 sampled cues, 8 kept procedural', () => {
    // A total, so a batch that silently halves cannot pass every per-item rule above.
    expect(REAL.credits.cues).toHaveLength(10);
    expect(Object.keys(REAL.credits.kept_on_synth)).toHaveLength(8);
    expect(REAL.onDisk).toHaveLength(22);
  });
});

// ── the mutation suite: every rule must be reachable ─────────────────────────────────────────

/** A deep copy of the real snapshot whose functions still read the real disk. */
function mutable(): Ctx {
  return {
    ...REAL,
    credits: structuredClone(REAL.credits),
    packs: structuredClone(REAL.packs),
    urls: structuredClone(REAL.urls) as Record<string, readonly string[]>,
    onDisk: [...REAL.onDisk],
    allCues: [...REAL.allCues],
  };
}

describe('the gate itself — each rule must go red when its contract is broken', () => {
  /** Assert a rule complains, and that its complaint names the thing that was broken. */
  function fails(rule: (c: Ctx) => string[], ctx: Ctx, mentions: string) {
    const problems = rule(ctx);
    expect(problems.length, 'rule stayed silent on a broken snapshot').toBeGreaterThan(0);
    expect(problems.join(' | ')).toContain(mentions);
  }

  it('an orphan file on disk', () => {
    const c = mutable();
    c.onDisk = [...c.onDisk, 'sfx-unit-attack_99.mp3'];
    fails(RULES.diskSet, c, 'orphan on disk');
  });

  it('a file credits.json promises but nobody shipped', () => {
    const c = mutable();
    c.onDisk = c.onDisk.filter((f) => f !== 'sfx-base-hit_00.mp3');
    fails(RULES.diskSet, c, 'declared but missing');
  });

  it('a cue recorded on both sides at once', () => {
    const c = mutable();
    c.credits.kept_on_synth['sfx.ui.tap'] = 'x'.repeat(MIN_RATIONALE + 1);
    fails(RULES.sides, c, 'BOTH sampled and kept-on-synth');
  });

  it('a cue that picked no side (the shape a NEW cue arrives in)', () => {
    const c = mutable();
    delete c.credits.kept_on_synth['sfx.ui.error'];
    fails(RULES.sides, c, 'no side recorded at all');
  });

  it('two cues with their import arrays swapped — the hole the first version could not see', () => {
    const c = mutable();
    const a = c.urls['sfx.card.play']!;
    const b = c.urls['sfx.spell.cast']!;
    // Same variant count on both, so every count-based rule stays green.
    expect(a).toHaveLength(b.length);
    c.urls['sfx.card.play'] = b;
    c.urls['sfx.spell.cast'] = a;
    fails(RULES.variantMapping, c, "pointing at another cue's recordings");
    // The point of the case: the rules that existed before are all still happy.
    expect(RULES.diskSet(c)).toEqual([]);
    expect(RULES.sides(c)).toEqual([]);
    expect(RULES.streams(c)).toEqual([]);
    expect(RULES.caps(c)).toEqual([]);
  });

  it('one variant swapped for another of the same cue (order matters — CueMixer indexes it)', () => {
    const c = mutable();
    const u = [...c.urls['sfx.unit.hit']!];
    [u[0], u[1]] = [u[1]!, u[0]!];
    c.urls['sfx.unit.hit'] = u;
    fails(RULES.variantMapping, c, 'sfx.unit.hit');
  });

  it('a kept-on-synth cue that quietly grew urls', () => {
    const c = mutable();
    c.urls['sfx.result.draw'] = ['/src/assets/audio/sfx-result-draw_00.mp3'];
    fails(RULES.variantMapping, c, 'kept-on-synth but cueAssets.ts ships urls');
  });

  it('a catalogue gain edited after the samples were peak-matched', () => {
    const c = mutable();
    c.catalogueGain = (cue) => (cue === 'sfx.unit.hit' ? 0.5 : CUE_CATALOGUE[cue as AudioCue]?.gain);
    fails(RULES.peakReference, c, 'sfx.unit.hit');
  });

  it('the SFX bus default moving out from under the measurements', () => {
    const c = mutable();
    c.credits.bus_gain_measured_at = 0.7;
    fails(RULES.peakReference, c, 'bus gain drifted');
  });

  it('a target peak that no longer follows from its own two factors', () => {
    const c = mutable();
    c.credits.cues[0]!.target_file_peak *= 1.5;
    fails(RULES.peakReference, c, 'target_file_peak');
  });

  it('a file whose bytes changed under the record', () => {
    const c = mutable();
    c.credits.cues[0]!.files[0]!.bytes += 1;
    fails(RULES.streams, c, 'bytes on disk');
  });

  it('a recorded sample rate the MPEG header disagrees with', () => {
    const c = mutable();
    c.credits.cues[0]!.files[0]!.sample_rate = 8000;
    fails(RULES.streams, c, 'MPEG header says');
  });

  it('a file that outlasts its cue cap', () => {
    const c = mutable();
    c.credits.cues[0]!.cap_ms = 10;
    fails(RULES.caps, c, 'cap');
  });

  it('one recording shipped as two different cues', () => {
    const c = mutable();
    c.credits.cues[1]!.files[0]!.source = c.credits.cues[0]!.files[0]!.source;
    fails(RULES.sourceUniqueness, c, 'feeds both');
  });

  it('a source pack that is not declared at all', () => {
    const c = mutable();
    c.packs.packs = c.packs.packs.filter((p) => p.id !== 'freesound');
    fails(RULES.packs, c, 'does not declare it');
  });

  it('a pack whose licence stopped being CC0', () => {
    const c = mutable();
    c.packs.packs[0]!.license = 'CC-BY-4.0';
    fails(RULES.packs, c, 'not CC0');
  });

  it('a pack that started requiring attribution', () => {
    const c = mutable();
    c.packs.packs[0]!.attribution_required = true;
    fails(RULES.packs, c, 'attribution_required');
  });

  it('a freesound sound with no per-sound licence record', () => {
    // The load-bearing one for that source: its licence is per upload, so the pack row alone
    // proves nothing about the file we actually shipped.
    const c = mutable();
    const fs = c.packs.packs.find((p) => p.id === 'freesound')!;
    fs.sounds = fs.sounds!.slice(1);
    fails(RULES.packs, c, 'no per-sound licence record');
  });

  it('a freesound sound whose own licence is not CC0', () => {
    const c = mutable();
    const fs = c.packs.packs.find((p) => p.id === 'freesound')!;
    fs.sounds![0]!.license = 'http://creativecommons.org/licenses/by/4.0/';
    fails(RULES.packs, c, 'not CC0');
  });

  it('a declared licence text file that is not there', () => {
    const c = mutable();
    c.licenceText = () => null;
    fails(RULES.licenceTexts, c, 'declared but missing');
  });

  it('a licence text that does not say CC0', () => {
    const c = mutable();
    c.licenceText = () => 'All rights reserved.';
    fails(RULES.licenceTexts, c, 'does not mention CC0');
  });

  it('a placeholder rationale on a shipped cue', () => {
    const c = mutable();
    c.credits.cues[0]!.rationale = 'TODO';
    fails(RULES.rationales, c, 'placeholder');
  });

  it('a placeholder reason on a kept-on-synth cue', () => {
    const c = mutable();
    c.credits.kept_on_synth['sfx.ui.reward'] = 'sounds better';
    fails(RULES.rationales, c, 'placeholder');
  });

  it('a cross-reference that points nowhere', () => {
    const c = mutable();
    c.credits.kept_on_synth['sfx.ui.reward'] = 'See `sfx.does.not.exist`.';
    fails(RULES.rationales, c, 'has no entry');
  });

  it('a cross-reference that points at itself', () => {
    const c = mutable();
    c.credits.kept_on_synth['sfx.ui.reward'] = 'See `sfx.ui.reward`.';
    fails(RULES.rationales, c, 'references itself');
  });

  it('a cross-reference chain that ends in a placeholder', () => {
    const c = mutable();
    c.credits.kept_on_synth['sfx.ui.reward'] = 'short';
    c.credits.kept_on_synth['sfx.result.draw'] = 'See `sfx.ui.reward`.';
    fails(RULES.rationales, c, 'target is a placeholder');
  });

  it('an unmutated snapshot still passes every rule (the control)', () => {
    // Without this, a `mutable()` that quietly broke something would make every case above pass
    // for the wrong reason.
    const c = mutable();
    for (const [name, rule] of Object.entries(RULES)) expect(rule(c), name).toEqual([]);
  });
});

// ── the header parser the stream rule leans on ───────────────────────────────────────────────

describe('mp3SampleRate', () => {
  /** A 4-byte MPEG frame header: sync + version/layer + rate index. */
  function header(version: number, layer: number, rateIdx: number): Buffer {
    return Buffer.from([
      0xff,
      0xe0 | (version << 3) | (layer << 1) | 1,
      (rateIdx << 2),
      0,
    ]);
  }

  it('reads every rate the pipeline can emit', () => {
    // RATE_LADDER in process.py, mapped back through the MPEG tables.
    expect(mp3SampleRate(header(3, 1, 0))).toBe(44100);
    expect(mp3SampleRate(header(3, 1, 1))).toBe(48000);
    expect(mp3SampleRate(header(3, 1, 2))).toBe(32000);
    expect(mp3SampleRate(header(2, 1, 0))).toBe(22050);
    expect(mp3SampleRate(header(2, 1, 1))).toBe(24000);
    expect(mp3SampleRate(header(2, 1, 2))).toBe(16000);
  });

  it('skips an ID3v2 tag rather than reading its bytes as a frame', () => {
    // A tag body full of 0xFF would otherwise look exactly like a sync word.
    const tag = Buffer.concat([
      Buffer.from('ID3'), Buffer.from([3, 0, 0]), Buffer.from([0, 0, 0, 8]),
      Buffer.alloc(8, 0xff),
    ]);
    expect(mp3SampleRate(Buffer.concat([tag, header(2, 1, 1)]))).toBe(24000);
  });

  it('skips a reserved version and a reserved rate index instead of inventing a number', () => {
    expect(mp3SampleRate(header(1, 1, 0))).toBeNull();     // version 1 is reserved
    expect(mp3SampleRate(header(3, 1, 3))).toBeNull();     // rate index 3 is reserved
  });

  it('ignores a non-Layer-III frame — the pipeline only ever writes Layer III', () => {
    expect(mp3SampleRate(header(3, 3, 0))).toBeNull();     // layer 3 = Layer I
    expect(mp3SampleRate(header(3, 2, 0))).toBeNull();     // layer 2 = Layer II
  });

  it('returns null on data with no frame at all', () => {
    expect(mp3SampleRate(Buffer.alloc(64))).toBeNull();
    expect(mp3SampleRate(Buffer.from('not audio'))).toBeNull();
    expect(mp3SampleRate(Buffer.alloc(0))).toBeNull();
  });

  it('finds the frame after leading junk', () => {
    expect(mp3SampleRate(Buffer.concat([Buffer.alloc(37, 0x13), header(3, 1, 1)]))).toBe(48000);
  });
});
