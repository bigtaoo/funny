/**
 * audioAssets.test.ts — holds the shipped audio files, `art/audio/credits.json`,
 * `art/audio/packs.json` and the live `AudioCue` / `CUE_CATALOGUE` to each other.
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
 * Run with: npm test
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ALL_CUES } from '../../src/audio/cueCatalogue';
import { CUE_CATALOGUE } from '../../src/audio/cueCatalogue';
import { CUE_ASSETS, variantCount } from '../../src/audio/cueAssets';
import type { AudioCue } from '../../src/audio/types';

const AUDIO_DIR = join(__dirname, '..', '..', 'src', 'assets', 'audio');
const ART = join(__dirname, '..', '..', '..', 'art', 'audio');

/** The SFX bus gain the delivered peaks were measured at — `DEFAULT_AUDIO_SETTINGS` master×sfx. */
const BUS_GAIN = 0.8;

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

const credits: Credits = JSON.parse(readFileSync(join(ART, 'credits.json'), 'utf8'));
const packs = JSON.parse(readFileSync(join(ART, 'packs.json'), 'utf8'));
const onDisk = readdirSync(AUDIO_DIR).filter((f) => /\.(mp3|wav|ogg)$/i.test(f)).sort();

/**
 * Sample rate straight out of the first MPEG audio frame header — no decoder, no dependency.
 * Skips an ID3v2 tag if the encoder wrote one, then scans for the 11-bit frame sync.
 */
function mp3SampleRate(bytes: Buffer): number | null {
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

describe('shipped audio assets', () => {
  it('credits.json and the files on disk are the same set', () => {
    const declared = credits.cues.flatMap((c) => c.files.map((f) => f.file)).sort();
    // Both directions: an orphan file ships bytes nobody can explain the licence of, and a
    // missing file is a BUILD failure via cueAssets.ts's import — but only once someone builds.
    expect(declared).toEqual(onDisk);
  });

  it('every cue in the union has picked a side, and only one', () => {
    const sampled = credits.cues.map((c) => c.cue);
    const synth = Object.keys(credits.kept_on_synth);
    expect(sampled.filter((c) => synth.includes(c))).toEqual([]);
    expect([...sampled, ...synth].sort()).toEqual([...ALL_CUES].sort());
  });

  it('credits.json agrees with cueAssets.ts on which cues are sample-backed', () => {
    for (const c of credits.cues) {
      expect(ALL_CUES, c.cue).toContain(c.cue as AudioCue);
      expect(variantCount(c.cue as AudioCue), c.cue).toBe(c.variants);
      expect(c.files.length, c.cue).toBe(c.variants);
    }
    for (const cue of Object.keys(credits.kept_on_synth)) {
      expect(CUE_ASSETS[cue as AudioCue], cue).toBeUndefined();
    }
  });

  it('the peak-match reference still matches the live catalogue and bus gain', () => {
    // THE check. See this file's header for why a drift here is invisible everywhere else.
    expect(credits.bus_gain_measured_at).toBe(BUS_GAIN);
    for (const c of credits.cues) {
      expect(c.catalogue_gain, `${c.cue}: cueCatalogue.ts gain changed since the samples were `
        + `peak-matched — re-run tools/audio-pipeline/process.py`)
        .toBe(CUE_CATALOGUE[c.cue as AudioCue].gain);
      const expected = c.target_delivered_peak / (c.catalogue_gain * BUS_GAIN);
      expect(c.target_file_peak, c.cue).toBeCloseTo(expected, 4);
    }
  });

  it('each file is a real MPEG Layer III stream at the recorded sample rate', () => {
    for (const c of credits.cues) {
      for (const f of c.files) {
        const p = join(AUDIO_DIR, f.file);
        const buf = readFileSync(p);
        expect(buf.length, f.file).toBe(f.bytes);
        expect(mp3SampleRate(buf), f.file).toBe(f.sample_rate);
      }
    }
  });

  it('no file outlasts its cue cap, and none is empty', () => {
    for (const c of credits.cues) {
      for (const f of c.files) {
        expect(f.duration_ms, f.file).toBeGreaterThan(0);
        // +1 ms of slack: the cap is applied in samples, so the ms figure rounds.
        expect(f.duration_ms, f.file).toBeLessThanOrEqual(c.cap_ms + 1);
      }
    }
  });

  it('every source pack is declared, licensed, and usable commercially without attribution', () => {
    expect(packs.all_sources_commercial_ok_without_attribution).toBe(true);
    const byId = new Map<string, any>(packs.packs.map((p: any) => [p.id, p]));
    const usedPacks = new Set(credits.cues.flatMap((c) => c.files.map((f) => f.source_pack)));
    for (const id of usedPacks) {
      const pack = byId.get(id);
      expect(pack, `credits.json ships from '${id}' but packs.json does not declare it`)
        .toBeDefined();
      expect(pack.license, id).toMatch(/CC0/);
      expect(pack.attribution_required, id).toBe(false);
    }
    // freesound's licence is per SOUND, not per pack, so the pack row alone proves nothing.
    const fs = byId.get('freesound');
    if (fs) {
      const usedFromFs = credits.cues
        .flatMap((c) => c.files)
        .filter((f) => f.source_pack === 'freesound')
        .map((f) => f.source.split('/')[1]!);
      const recorded = new Map<string, any>(fs.sounds.map((s: any) => [s.file, s]));
      for (const file of usedFromFs) {
        const s = recorded.get(file);
        expect(s, `no per-sound licence record for freesound/${file}`).toBeDefined();
        expect(s.license, file).toBe('http://creativecommons.org/publicdomain/zero/1.0/');
      }
    }
  });

  it('every pack that claims an archived licence text actually has one', () => {
    for (const pack of packs.packs) {
      if (!pack.license_text) continue;
      const p = join(ART, '..', '..', pack.license_text);
      expect(existsSync(p), `${pack.id}: ${pack.license_text} is declared but missing`).toBe(true);
      expect(readFileSync(p, 'utf8')).toMatch(/CC0/);
    }
  });

  it('every rationale says something — a placeholder is worse than an empty field', () => {
    // Both halves of the record are load-bearing: `rationale` is why THIS family was picked, and
    // `kept_on_synth` is why a cue has no files at all. Without the second, an empty entry in
    // cueAssets.ts is indistinguishable from an oversight, which is the exact state this whole
    // step was in for three rounds.
    for (const c of credits.cues) {
      expect(c.rationale.length, c.cue).toBeGreaterThan(60);
    }
    for (const [cue, why] of Object.entries(credits.kept_on_synth)) {
      // A cross-reference is allowed where several cues share one reason — the three gacha
      // reveal tiers are one decision about a relationship between them, and stating it three
      // times would make the record worse, not better. But the pointer has to RESOLVE: a
      // dangling "See `sfx.something`" is exactly the placeholder this test is looking for.
      const ref = /^See `([^`]+)`\.$/.exec(why);
      if (ref) {
        const target = ref[1]!;
        expect(credits.kept_on_synth[target], `${cue}: cross-references ${target}, which has no `
          + `kept_on_synth entry`).toBeDefined();
        expect(target, `${cue}: cross-references itself`).not.toBe(cue);
        expect(credits.kept_on_synth[target]!.length, target).toBeGreaterThan(60);
        continue;
      }
      expect(why.length, cue).toBeGreaterThan(60);
    }
  });
});
