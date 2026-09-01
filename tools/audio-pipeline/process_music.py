"""Convert a music master into the shipped BGM track under client/src/assets/audio/.

Separate from `process.py` because BGM is a different kind of asset and shares almost none of
its arithmetic (AUDIO_DESIGN §7 step 7):

  * **No trim, no cap, no peak-match.** A cue is an event, so the pipeline owns its onset, its
    length and its level. A music bed is a finished musical statement -- its intro, its fade-out
    and its own dynamics ARE the content. Scaling it to a target peak before a lossy encode
    would only spend the encoder's headroom to move a number that `MUSIC_TRACKS[].gain` moves
    for free at runtime.
  * **The level decision therefore lives in the catalogue, not in the file.** `musicTracks.ts`
    states the gain and the delivered-peak arithmetic it was chosen for; this script only
    reports the file peak that arithmetic is anchored to.
  * **The encode is a quality search, not a size search.** `process.py` keeps the smallest file
    at any bandwidth-legal rate because a 40 ms jab has no top end to lose. 3.5 minutes of music
    does, so the ladder here runs over libsndfile's compression level and stops at the smallest
    file that still clears two measured gates (see `LADDER` / `pick`).

Usage:
    ./venv/Scripts/python process_music.py [--dry-run]
"""
import argparse, json, os, sys
import numpy as np
import soundfile as sf

SRC = "art/audio/sources"
OUT = "client/src/assets/audio"
CREDITS = "art/audio/credits.json"

# The BGM channel gain the delivered peaks below are quoted at -- `DEFAULT_AUDIO_SETTINGS` in
# `audio/audioSettings.ts` (master 1.0 x bgm 0.5). Not a tunable: change it here only if that
# default changes. `audioAssets.test.ts` holds the two together.
MUSIC_CHANNEL = 0.5

# track id -> (source file, catalogue gain, why this track, licence facts). The `why` is the part
# no measurement can supply; it is copied into credits.json so a later reader can tell a decision
# from an accident.
#
# The gain is `MUSIC_TRACKS[track].gain` in `client/src/audio/musicTracks.ts`, quoted here rather
# than derived, so the delivered peak this script reports can be checked against the one that
# file's comment argues for. **Music is not peak-matched** (see the module docstring), so unlike
# `process.py`'s TARGETS this number does not change a single byte of the output -- it only
# decides what the recorded delivered peak MEANS.
TRACKS = {
    "bgm.lobby": (
        "first-party/doodle-bed.flac",
        0.20,
        "The first and so far only music in the game. A 3:33 bed at -17 dBFS RMS with a 13.8 dB "
        "crest factor -- quiet, wide-dynamic and with no percussive transients, which is what "
        "lets it sit under a mix whose loudest cue peaks at 0.151 without ever competing for the "
        "same moment. Shipped as `bgm.lobby` rather than `bgm.battle` because it opens and closes "
        "on a fade: it is written to be entered and left, not to be interrupted by a match.",
        {"source_pack": "first-party", "license": "proprietary (project-owned)",
         "attribution_required": False},
    ),
}

# libsndfile compression levels to try, smallest file first. 1.0 is not in the ladder: libsndfile
# rejects it outright ("Error set compression level 1.0").
LADDER = [0.9, 0.8, 0.7, 0.6, 0.5, 0.3, 0.0]

# -- the two gates the ladder is searched against --------------------------------------------
#
# Both are relative to the SOURCE, never to an absolute spectrum: this master is already
# band-limited (its own 99% rolloff is 12.0 kHz), so a fixed "must reach 16 kHz" rule would
# measure the composer, not the encoder.
#
# 1. ROLLOFF. Keep at least this fraction of the source's own 99%-energy rolloff. The ladder for
#    `doodle-bed.flac` has a knee right here -- 0.7 keeps 90% (10847/12010 Hz), 0.9 keeps 51%
#    (6095 Hz), i.e. half the spectrum disappears in one rung. 0.85 sits inside that knee.
MIN_ROLLOFF_KEPT = 0.85
# 2. BAND ERROR. Per-band energy must land within this many dB of the source, but only in bands
#    that carry real signal -- a band 40 dB under the track's loudest one is inaudible, and
#    holding an encoder to 0.5 dB there would reject every rung of the ladder for nothing.
MAX_BAND_ERR_DB = 0.5
AUDIBLE_BAND_FLOOR_DB = 40.0
BAND_EDGES = [0, 250, 1000, 4000, 8000, 12000, 16000, 24000]

FFT_N = 1 << 14
# Both spectral measures read a 30 s window from the MIDDLE of the track. The middle rather than
# the whole file because both ends of a bed are a fade, and averaging those in would move every
# band by the same amount in every candidate -- measuring the fade, not the encoder.
WINDOW_S = 30


def _mid_frames(y: np.ndarray, sr: int) -> np.ndarray:
    mid = len(y) // 2
    frames = min((len(y) - mid) // FFT_N, int(WINDOW_S * sr) // FFT_N)
    return y[mid:mid + frames * FFT_N].reshape(-1, FFT_N) * np.hanning(FFT_N)


def bands(y: np.ndarray, sr: int) -> np.ndarray:
    """Mean per-band energy over the mid-track window."""
    freqs = np.fft.rfftfreq(FFT_N, 1 / sr)
    S = (np.abs(np.fft.rfft(_mid_frames(y, sr), axis=1)) ** 2).mean(axis=0)
    return np.array([S[(freqs >= a) & (freqs < b)].sum()
                     for a, b in zip(BAND_EDGES, BAND_EDGES[1:])])


def rolloff(y: np.ndarray, sr: int, frac: float = 0.99) -> float:
    """Frequency below which `frac` of the mid-track energy lies."""
    freqs = np.fft.rfftfreq(FFT_N, 1 / sr)
    S = np.abs(np.fft.rfft(_mid_frames(y, sr), axis=1)).mean(axis=0)
    c = np.cumsum(S)
    return float(freqs[np.searchsorted(c, c[-1] * frac)])


def measure(x: np.ndarray) -> dict:
    """Objective facts about a music file. Same spirit as audit.py, different limits."""
    mono = x.mean(axis=1)
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt((x ** 2).mean()))
    out = {
        "channels": int(x.shape[1]),
        "peak": round(peak, 4),
        "peak_dbfs": round(20 * np.log10(max(peak, 1e-12)), 2),
        "rms_dbfs": round(20 * np.log10(max(rms, 1e-12)), 2),
        "crest_db": round(20 * np.log10(max(peak, 1e-12) / max(rms, 1e-12)), 2),
        "clipped_samples": int(np.sum(np.abs(x) >= 0.999)),
        "dc_offset": round(float(np.abs(mono.mean())), 5),
    }
    if x.shape[1] == 2:
        out["lr_correlation"] = round(float(np.corrcoef(x[:, 0], x[:, 1])[0, 1]), 3)
    return out


def check_source(m: dict, dur_s: float) -> list:
    """Reject a master the encode cannot fix.

    Deliberately short: unlike the found-foley pool, a music master is authored, so the failure
    modes worth gating are the ones that would be baked into every byte we then ship.
    """
    bad = []
    if m["clipped_samples"] > 0:
        # Same reasoning as process.py's source gate: distortion survives everything downstream,
        # and nothing measured on the OUTPUT can tell it apart from intended loudness.
        bad.append(str(m["clipped_samples"]) + " clipped samples")
    if m["dc_offset"] > 0.01:
        # A DC offset costs headroom on every sample and is inaudible on its own -- exactly the
        # kind of defect that only ever surfaces as "the loud parts distort".
        bad.append("DC offset " + str(m["dc_offset"]))
    if not 30 <= dur_s <= 600:
        # Below 30 s a loop is a ringtone; above 10 minutes it is a download, not a bed.
        bad.append("duration %.1f s outside 30-600 s" % dur_s)
    return bad


def pick(x: np.ndarray, sr: int, path: str):
    """Encode down the ladder and keep the smallest file that clears both gates.

    Every rung is written to a temp file and read back -- the numbers below are measured on the
    DECODED result, not predicted from the encoder's settings.
    """
    ref_mono = x.mean(axis=1)
    B0 = bands(ref_mono, sr)
    R0 = rolloff(ref_mono, sr)
    audible = B0 >= B0.max() * 10 ** (-AUDIBLE_BAND_FLOOR_DB / 10)
    tried = []
    for cl in LADDER:
        tmp = path + "." + str(cl) + ".tmp"
        sf.write(tmp, x, sr, format="MP3", subtype="MPEG_LAYER_III", compression_level=cl)
        y, sr2 = sf.read(tmp, always_2d=True, dtype="float64")
        ym = y.mean(axis=1)
        B = bands(ym, sr2)
        R = rolloff(ym, sr2)
        err = 10 * np.log10((B + 1e-20) / (B0 + 1e-20))
        worst = float(np.max(np.abs(err[audible])))
        kept = R / R0
        n = os.path.getsize(tmp)
        tried.append({"compression_level": cl, "bytes": n, "rolloff_kept": round(kept, 3),
                      "worst_band_err_db": round(worst, 2)})
        if kept >= MIN_ROLLOFF_KEPT and worst <= MAX_BAND_ERR_DB:
            os.replace(tmp, path)
            return cl, n, {
                "source_rolloff99_hz": round(R0),
                "encoded_rolloff99_hz": round(R),
                "rolloff_kept": round(kept, 3),
                "worst_audible_band_err_db": round(worst, 2),
                "band_edges_hz": BAND_EDGES,
                "audible_bands": [bool(v) for v in audible],
                "ladder": tried,
            }
        os.remove(tmp)
    raise SystemExit("no rung of the ladder cleared both gates: " + repr(tried))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="measure and gate, write nothing")
    args = ap.parse_args()

    root = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
    os.chdir(root)

    entries = []
    for track, (rel, gain, why, lic) in TRACKS.items():
        src = os.path.join(SRC, rel)
        if not os.path.exists(src):
            print("REJECT " + track + ": no such source " + rel, file=sys.stderr)
            return 1
        x, sr = sf.read(src, always_2d=True, dtype="float64")
        dur_s = len(x) / sr
        m = measure(x)
        bad = check_source(m, dur_s)
        if bad:
            for b in bad:
                print("REJECT %s: %s: %s" % (track, rel, b), file=sys.stderr)
            return 1
        stem = track.replace(".", "-")
        print("%-12s %s  %6.1f s  %dch %d Hz  peak %.4f (%+.2f dBFS)  rms %+.2f dBFS  "
              "crest %.1f dB" % (track, rel, dur_s, m["channels"], sr, m["peak"],
                                 m["peak_dbfs"], m["rms_dbfs"], m["crest_db"]))
        if args.dry_run:
            continue
        os.makedirs(OUT, exist_ok=True)
        path = os.path.join(OUT, stem + ".mp3")
        cl, nbytes, deltas = pick(x, sr, path)
        enc, enc_sr = sf.read(path, always_2d=True, dtype="float64")
        em = measure(enc)
        print("  -> %s.mp3  cl=%s  %d bytes  %.0f kbps  peak %.4f  rolloff %d Hz (%.0f%% of "
              "source)  worst audible band err %+.2f dB"
              % (stem, cl, nbytes, nbytes * 8 / dur_s / 1000, em["peak"],
                 deltas["encoded_rolloff99_hz"], deltas["rolloff_kept"] * 100,
                 deltas["worst_audible_band_err_db"]))
        delivered = em["peak"] * gain * MUSIC_CHANNEL
        print("     delivered peak %.4f = file %.4f x gain %.2f x bgm channel %.2f"
              % (delivered, em["peak"], gain, MUSIC_CHANNEL))
        entry = {"track": track, "file": stem + ".mp3", "source": rel}
        entry.update(lic)
        entry.update({
            "sample_rate": enc_sr,
            "channels": em["channels"],
            "duration_ms": round(dur_s * 1000, 1),
            "bytes": nbytes,
            "compression_level": cl,
            "source_peak": m["peak"],
            "source_rms_dbfs": m["rms_dbfs"],
            "file_peak": em["peak"],
            "file_rms_dbfs": em["rms_dbfs"],
            "crest_db": em["crest_db"],
            "catalogue_gain": gain,
            "music_channel_measured_at": MUSIC_CHANNEL,
            "delivered_peak": round(delivered, 4),
            "encode": deltas,
            "rationale": why,
        })
        entries.append(entry)

    if args.dry_run:
        return 0

    with open(CREDITS, encoding="utf-8") as fh:
        credits = json.load(fh)
    credits["music"] = entries
    with open(CREDITS, "w", encoding="utf-8") as fh:
        json.dump(credits, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print("\n%d track(s), %d bytes -> %s" % (len(entries), sum(e["bytes"] for e in entries), OUT))
    print("credits.json updated (" + CREDITS + ")")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
