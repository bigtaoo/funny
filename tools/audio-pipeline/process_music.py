"""Produce the shipped BGM loops from AI-generated masters (AUDIO_DESIGN §2.3 / §7 step 7).

The second driver beside `process.py` (the 18 cues). It is separate because all three of its
inputs differ from a cue's, and each difference changes a STEP rather than a parameter:

  * The input is a 3-5 minute SONG, not a cue. A loop REGION has to be chosen, and its two ends
    have to match each other across the player's crossfade window -- so the region is an
    authored decision recorded in TRACKS below, arrived at by measurement (`--search`) rather
    than by ear-and-eyeball.
  * The input is mastered to ~0 dBFS. The cue set was deliberately peak-matched DOWN to the
    synth voices it replaced and lives at -14..-23 dBFS on file (§0.4). There is no synth voice
    for music to match, so level is set by a BAND TARGET instead: the 250-2000 Hz RMS, which is
    the band every cue peaks in. See `audit.py`'s `music` gate for where -29 dBFS comes from.
  * It is stereo and it STAYS stereo. `audit.py`'s sfx/ui gates forbid stereo ("wastes bytes")
    because a 43 ms cue's second channel is pure overhead and doubles what the `SampleBank`
    holds decoded in RAM. A 60 s bed STREAMS, so neither argument survives.

One property worth stating because it is not obvious: every filter here runs as a single
zero-phase multiply over the WHOLE region's spectrum. That is circular convolution, and a loop
region IS circular -- so filtering cannot introduce the endpoint discontinuity that a
windowed/overlap-add filter would. `selftest.py` asserts that circularity directly.

**No `selfcheck()` in this file**, unlike daydayup's version of it: this repo keeps every check
in `selftest.py`, so that one command answers "is the pipeline sound" for both drivers. The
checks that daydayup wrote inline came across into that file.

Paths here are REPO-ROOT relative, matching `process.py` -- so like it, this driver is run
from the repo root rather than from this directory (`audit.py`, which takes paths as arguments,
is the one that is run from here).

Usage, from the repo root (P = tools/audio-pipeline):
    P/venv/Scripts/python P/process_music.py --search "Some Suno Title.mp3"
    P/venv/Scripts/python P/process_music.py --search bgm.lobby   # ...with its shelf applied
    P/venv/Scripts/python P/process_music.py [--track bgm.lobby] [--out DIR]
"""
import argparse, os, shutil
import numpy as np
import soundfile as sf

# The band measurement lives in `audit.py` -- it is the measurement+gate module, and the
# producer SHARING it is what keeps the number this script reports and the number the gate
# checks from drifting apart. daydayup let them drift three times; see `profile_diff`'s
# docstring there for what each drift cost.
from audit import (BAND_N, MID_BAND, XFADE_S, band_edges, band_profile, band_rms,
                   profile_diff, xfade_band_diff)
# The delivered-headroom report is the whole reason MID_TARGET_DBFS has the value it has, so it
# is computed from the cue set's own numbers rather than restated. `audioAssets.test.ts` already
# pins `process.py`'s TARGETS against the live `cueCatalogue.ts`, so importing them here inherits
# that guard instead of opening a second place for the gains to go stale.
from process import BUS_GAIN, TARGETS

# Masters live under the same source tree as the cue foley, one directory per provenance
# (`first-party/` for a track the project owns, `suno/` for a generated one). The BRIEFS for the
# tracks that still need generating are in `art/audio/suno/BRIEFS.md`.
SRC_DIR = 'art/audio/sources'
OUT_DIR = 'client/src/assets/audio/music'

# Level target: the 250-2000 Hz RMS every track is normalised to. Derived in `audit.py`'s
# `music` gate comment from this repo's measured cue peaks -- not copied from daydayup's -30.
MID_TARGET_DBFS = -29.0
PEAK_CEILING_DBFS = -3.0     # headroom for inter-sample peaks and MP3 encode overshoot

# The BGM bus default (`DEFAULT_AUDIO_SETTINGS` in `audio/audioSettings.ts`: master 1.0 x bgm
# 0.5). Only used for the report, but it is half of the derivation, so it is stated rather than
# folded into a constant somebody would later read as arbitrary.
MUSIC_BUS_GAIN = 0.5

# Cues excluded from the headroom report's "binding constraint" line, with the reason. See the
# `music` gate comment: `ink.tick` is authored as the faintest thing in the game AND throttled
# to one tick per 10 ink (§0.1), so holding the bed 10 dB under it would drop the music 6 dB
# below what anything else in the mix justifies.
NOT_LEGIBILITY_CRITICAL = {'sfx.ink.tick'}

RATE_LADDER = [24000, 32000, 44100, 48000]
QUALITY_LADDER = [0.6, 0.4, 0.2]     # libsndfile VBR quality; higher number = smaller file

# track id -> the authored decision. `region` is (start_s, length_s) from the crossfade-aware
# search below; `shelf` is (corner Hz, gain dB) or None; `why` is the record that goes into
# `art/audio/credits.json`.
#
# `--search` works on a bare filename with no entry here, which is the order the work actually
# happens in: acquire the master, search, decide, record, then process.
TRACKS: dict[str, dict] = {
    'bgm.lobby': {
        'src': 'first-party/doodle-bed.flac',
        # From `--search first-party/doodle-bed.flac`. The 60-75 s bucket, not the 20-30 s one
        # that scored best overall (0.27 dB at 13.5s/23.5s): a 23.5 s loop turns over every 24
        # seconds in a screen players sit on for minutes, and a seam nobody can hear is worth
        # nothing if the repetition is what they notice instead. 0.58 dB is a quarter of the
        # 2.5 dB gate, and 74 s is three times the musical distance between repeats.
        'region': (12.5, 74.0),
        # No shelf. The master's own 20-250 Hz sits 14 dB under its mid band (this is a light
        # acoustic bed, not a mix with a sub); a shelf here would be attenuating something that
        # is not in the way, and `--search` was therefore run raw.
        'shelf': None,
        'why': (
            'The first music in the game, and project-owned rather than licensed or generated. '
            'A 74 s region lifted out of a 3:33 master, chosen by the same crossfade-window band '
            'measure the gate then applies (0.58 dB across the seam, level within 0.09 dB). '
            'Shipped as bgm.lobby rather than bgm.battle because it has no percussive transients '
            'and no forward pull -- it is written to be sat on, not to be interrupted.'
        ),
    },
}


def db(x: float) -> float:
    return -np.inf if x <= 1e-12 else 20.0 * np.log10(x)


def low_shelf(x: np.ndarray, sr: int, f0: float, gain_db: float) -> np.ndarray:
    """Zero-phase low shelf: `gain_db` below f0, unity well above, smooth between.

    g(f) = 1 + (G-1)/(1+(f/f0)^ORDER), applied as ONE FFT over the whole region. Circular, so
    the loop's endpoints stay exactly as continuous as they already were.

    ORDER is 4, not 2. A 2nd-order shelf at f0=80 Hz reaches only -6.9 dB at 40 Hz -- and
    40-49 Hz is the exact band a shelf like this exists to tame, so the gentler curve
    under-delivers where it is aimed. `selftest.py` asserts the REQUIREMENT (near-full
    attenuation by f0/2, unity by 4*f0, monotonic between) rather than the algebra, which is
    what caught the order being wrong in daydayup.
    """
    g_lin = 10.0 ** (gain_db / 20.0)
    n = len(x)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    gain = 1.0 + (g_lin - 1.0) / (1.0 + (freqs / f0) ** 4)
    out = np.empty_like(x)
    for c in range(x.shape[1]):
        out[:, c] = np.fft.irfft(np.fft.rfft(x[:, c]) * gain, n)
    return out


def set_band_target(x: np.ndarray, sr: int, target_db: float) -> tuple[np.ndarray, float]:
    """Scale so the MID_BAND RMS lands on target_db. Returns (signal, gain applied in dB)."""
    delta = target_db - band_rms(x, sr, *MID_BAND)
    return x * (10.0 ** (delta / 20.0)), delta


def peak_guard(x: np.ndarray, ceiling_db: float) -> tuple[np.ndarray, float]:
    """Scale down if the peak exceeds the ceiling. Never scales UP -- a bed that came in quiet
    is a level decision `set_band_target` already made, and lifting it here would undo that."""
    peak = db(float(np.max(np.abs(x))))
    if peak <= ceiling_db:
        return x, 0.0
    trim_db = ceiling_db - peak
    return x * (10.0 ** (trim_db / 20.0)), trim_db


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Per-channel spectral resample. `process.py`'s version is mono-only, by design."""
    if sr_in == sr_out:
        return x
    n_out = int(round(len(x) * sr_out / sr_in))
    out = np.zeros((n_out, x.shape[1]))
    for c in range(x.shape[1]):
        spec = np.fft.rfft(x[:, c])
        bins = n_out // 2 + 1
        new = np.zeros(bins, dtype=complex)
        keep = min(len(spec), bins)
        new[:keep] = spec[:keep]
        out[:, c] = np.fft.irfft(new, n_out) * (n_out / len(x))
    return out


def search_regions(src: str, shelf: tuple | None = None, lo_s: float = 20.0,
                   hi_s: float = 90.0, hop_s: float = 0.5) -> list[tuple]:
    """Rank loop regions by the SAME measure the shipped file is then judged by.

    That sentence is the whole design of this function, and daydayup paid for it three times
    (see `audit.py`'s `profile_diff`). All three failures had one shape: a ranking metric
    coarser than, or differently weighted from, or applied to a different signal than the
    ACCEPTANCE metric, each producing candidates that scored well here and failed the gate.

    So: full-window `band_profile` + `profile_diff`, the same two calls the gate makes, on the
    PROCESSED signal (the shelf is applied first, because attenuating below 80 Hz moves the
    energy weighting onto the mids where head and tail differ more -- a region daydayup ranked
    at 1.41 dB raw measured 3.69 dB once shelved). Level normalisation is a scalar and cannot
    change a dB difference, and the resample only drops bands near -80 dBFS, so the shelf is
    the one step that has to be inside the loop.

    Cost adds small terms for level mismatch and for settling in a passage quieter than the
    track's own median -- without the second one a search lands on the intro, which is
    seamless with itself for the boring reason that almost nothing is playing.
    """
    x, sr = sf.read(src, dtype='float32', always_2d=True)
    if shelf:
        x = low_shelf(x.astype(np.float64), sr, *shelf)
    mono = x.mean(axis=1)
    w, hop = int(XFADE_S * sr), int(hop_s * sr)
    nwin = (len(mono) - w) // hop + 1
    if nwin <= 0:
        raise SystemExit(f'{src}: shorter than the {XFADE_S} s crossfade window')
    prof = np.stack([band_profile(mono[i * hop:i * hop + w], sr) for i in range(nwin)])
    lvl = np.array([db(float(np.sqrt(np.mean(mono[i * hop:i * hop + w] ** 2))))
                    for i in range(nwin)])
    med = float(np.median(lvl))
    steps_lo, steps_hi = int(lo_s / hop_s), int(hi_s / hop_s)
    xf_steps = int(XFADE_S / hop_s)
    out = []
    for i in range(nwin):
        for k in range(steps_lo, steps_hi + 1):
            j = i + k - xf_steps
            if j >= nwin:
                break
            d = profile_diff(prof[i], prof[j])
            dl = abs(lvl[j] - lvl[i])
            quiet = max(0.0, med - min(lvl[i], lvl[j]))
            out.append((d + 0.5 * dl + 0.5 * quiet, i * hop_s, k * hop_s, d, dl, lvl[i], lvl[j]))
    out.sort(key=lambda r: r[0])
    return out


def report_search(name: str) -> None:
    """`name` is a track id (searched WITH that track's shelf) or a bare source filename."""
    spec = TRACKS.get(name)
    src = os.path.join(SRC_DIR, spec['src']) if spec else (
        name if os.path.isabs(name) else os.path.join(SRC_DIR, name))
    shelf = spec['shelf'] if spec else None
    best = search_regions(src, shelf=shelf)
    print()
    print(f'{os.path.basename(src)}: {len(best)} candidate regions, ranked by full-window '
          f'band difference'
          + (f', shelf {shelf[1]:+.0f} dB below {shelf[0]:.0f} Hz applied' if shelf
             else ' (no shelf)'))
    print('    bucket     cost   start      len   band-diff  lvl-diff   head    tail')
    for lo, hi in ((20, 30), (30, 45), (45, 60), (60, 75), (75, 90)):
        sel = [r for r in best if lo <= r[2] < hi]
        if not sel:
            continue
        c, st, ln, d, dl, hr, tr = sel[0]
        print(f'    {lo:3}-{hi:3}s  {c:6.2f}  {st:6.1f}s  {ln:5.1f}s   {d:6.2f}dB   '
              f'{dl:5.2f}dB  {hr:6.1f}  {tr:6.1f}')


def encode_smallest(y: np.ndarray, sr_in: int, path: str,
                    tol_db: float = 1.5) -> tuple[int, int, float, float]:
    """Smallest MP3 over (rate x quality) that survives a MEASURED fidelity check.

    The check is not "did the encoder run" -- it decodes the result back and compares the two
    bands the mix depends on (250-2000 Hz where the cues peak, and 2-8 kHz where a page-turn or
    a marker squeak has to cut through) against the pre-encode signal. Without it, "smallest
    file wins" would happily ship a setting that quietly dulls the bed.

    Returns (rate, bytes, quality, worst band error in dB).
    """
    want_mid = band_rms(y, sr_in, *MID_BAND)
    want_sfx = band_rms(y, sr_in, 2000.0, 8000.0)
    best = None
    for r in RATE_LADDER:
        z = resample(y, sr_in, r)
        for q in QUALITY_LADDER:
            tmp = f'{path}.{r}.{q}.tmp'
            sf.write(tmp, z, r, format='MP3', subtype='MPEG_LAYER_III',
                     bitrate_mode='VARIABLE', compression_level=q)
            back, bsr = sf.read(tmp, dtype='float64', always_2d=True)
            err = max(abs(band_rms(back, bsr, *MID_BAND) - want_mid),
                      abs(band_rms(back, bsr, 2000.0, min(8000.0, bsr / 2 - 1)) - want_sfx))
            n = os.path.getsize(tmp)
            if err > tol_db:
                os.remove(tmp)
                continue
            if best is None or n < best[1]:
                if best:
                    os.remove(best[4])
                best = (r, n, q, err, tmp)
            else:
                os.remove(tmp)
    if best is None:
        raise SystemExit(f'no (rate, quality) on the ladder held {tol_db} dB for {path}')
    shutil.move(best[4], path)
    return best[0], best[1], best[2], best[3]


def delivered_cue_peaks() -> dict[str, float]:
    """Delivered peak dBFS per cue: file peak x catalogue gain x SFX bus.

    `process.py`'s TARGETS already holds the delivered figure directly (it is what the file
    peaks were derived FROM), so this is a read rather than a computation -- which is the point:
    the headroom line below compares two delivered numbers, and neither is re-derived here.
    """
    return {cue: db(delivered) for cue, (delivered, _gain) in TARGETS.items()}


def headroom_report(mid_dbfs: float) -> None:
    """How far each cue's delivered peak stands above the bed's delivered mid-band RMS.

    This is the derivation in `audit.py`'s `music` gate, recomputed against the file that was
    actually produced -- so a track that passed the gate but whose level drifted for any other
    reason still has to show its ladder here.
    """
    bed = mid_dbfs + db(MUSIC_BUS_GAIN)
    rows = sorted(((cue, p - bed) for cue, p in delivered_cue_peaks().items()),
                  key=lambda kv: -kv[1])
    print(f'       bed delivers {bed:.2f} dBFS mid-band RMS (file {mid_dbfs:.2f} x bus '
          f'{MUSIC_BUS_GAIN}); cue delivered peak above it:')
    for i in range(0, len(rows), 4):
        print('         ' + '   '.join(f'{c.removeprefix("sfx."):<18} {d:+5.1f}'
                                       for c, d in rows[i:i + 4]))
    binding = min((r for r in rows if r[0] not in NOT_LEGIBILITY_CRITICAL), key=lambda kv: kv[1])
    print(f'       binding constraint: {binding[0]} at {binding[1]:+.1f} dB'
          + ('  <-- UNDER the 10 dB the target was set for' if binding[1] < 10.0 else ''))


def process(track: str, out_dir: str) -> None:
    spec = TRACKS[track]
    src = os.path.join(SRC_DIR, spec['src'])
    t0, dur = spec['region']
    info = sf.info(src)
    x, sr = sf.read(src, dtype='float64', always_2d=True,
                    start=int(t0 * info.samplerate), stop=int((t0 + dur) * info.samplerate))

    print(f'\n{track}  <- {spec["src"]}  region {t0}-{t0 + dur}s ({dur}s, {x.shape[1]} ch)')
    print(f'  in   peak {db(float(np.max(np.abs(x)))):+7.2f} dBFS   '
          f'mid {band_rms(x, sr, *MID_BAND):7.2f}   '
          f'sub {band_rms(x, sr, 20, 250):7.2f}   sfx {band_rms(x, sr, 2000, 8000):7.2f}')

    if spec['shelf']:
        f0, g = spec['shelf']
        print(f'       xfade band-diff {xfade_band_diff(x, sr):5.2f} dB (raw -- NOT the '
              f'comparable figure, the shelf below moves the energy weighting)')
        x = low_shelf(x, sr, f0, g)
        print(f'  shelf {g:+.1f} dB below {f0:.0f} Hz  ->  '
              f'sub {band_rms(x, sr, 20, 250):7.2f} dBFS, '
              f'xfade band-diff {xfade_band_diff(x, sr):5.2f} dB')
    else:
        print(f'       xfade band-diff {xfade_band_diff(x, sr):5.2f} dB')

    x, gain = set_band_target(x, sr, MID_TARGET_DBFS)
    print(f'  level {gain:+.2f} dB  ->  mid {band_rms(x, sr, *MID_BAND):.2f} dBFS '
          f'(target {MID_TARGET_DBFS})')
    x, trim = peak_guard(x, PEAK_CEILING_DBFS)
    if trim:
        print(f'  peak guard {trim:+.2f} dB (the mid target is missed by that much)')

    os.makedirs(out_dir, exist_ok=True)
    # Shipped name flattens the track id's dots to dashes, exactly as `process.py` does for
    # cues -- `bgm.lobby` -> `bgm-lobby.mp3`. No `_NN` suffix: a track has no variants.
    path = os.path.join(out_dir, f'{track.replace(".", "-")}.mp3')
    rate, nbytes, q, err = encode_smallest(x, sr, path)

    back, bsr = sf.read(path, dtype='float64', always_2d=True)
    kbps = nbytes * 8 / (len(back) / bsr) / 1000.0
    mid = band_rms(back, bsr, *MID_BAND)
    print(f'  out  {rate} Hz, VBR q={q}, {nbytes / 1024:.1f} kB, {kbps:.1f} kbps, '
          f'band error {err:.2f} dB')
    print(f'       peak {db(float(np.max(np.abs(back)))):+7.2f} dBFS   mid {mid:7.2f}   '
          f'sub {band_rms(back, bsr, 20, 250):7.2f}   '
          f'sfx {band_rms(back, bsr, 2000, min(8000, bsr / 2 - 1)):7.2f}')
    # The decoded length is what `musicCatalogue.ts`'s `lengthS` has to carry: the player starts
    # the next deck at `lengthS - XFADE_S`, so a value that drifts from the file puts the wrap in
    # the wrong place -- audible as a stumble rather than as an error. MP3 frame padding means
    # this is NOT the region length asked for, which is the whole reason it is printed.
    print(f'       decoded {len(back) / bsr:.3f} s (region asked for {dur} s) '
          f'<- musicCatalogue lengthS')
    print(f'       xfade band-diff {xfade_band_diff(back, bsr):5.2f} dB (gate: <= 2.5)')
    headroom_report(mid)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--track', choices=sorted(TRACKS), action='append')
    ap.add_argument('--out', default=OUT_DIR)
    ap.add_argument('--search', metavar='TRACK_OR_FILE', action='append',
                    help='rank loop regions and exit. A track id searches that source WITH the '
                         'track shelf applied, which is what the gate then measures; a bare '
                         'filename searches the raw master.')
    a = ap.parse_args()
    if a.search:
        for f in a.search:
            report_search(f)
        return
    if not TRACKS:
        raise SystemExit('TRACKS is empty -- generate the masters (art/audio/suno/BRIEFS.md), '
                         'then --search one to pick its region and record it here.')
    for t in (a.track or sorted(TRACKS)):
        process(t, a.out)


if __name__ == '__main__':
    main()
