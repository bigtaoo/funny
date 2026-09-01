"""Convert the picked source foley into the shipped cue set under client/src/assets/audio/.

Steps, in order: mono -> trim -> cap (faded) -> peak-match -> smallest bandwidth-legal MP3.
Ported from daydayup's `process_all.py` (2026-09-01) with one structural change and two new
gates; everything else is the same arithmetic.

**The structural change: where the peak target comes from.** daydayup read a `synth.json`
produced by auditing re-rendered synth cues. funny cannot: its synth voices are live WebAudio
graphs, there is no offline render, and AUDIO_DESIGN §7 step 6 was already corrected once for
assuming otherwise -- an `audioSynth.ts` voice's `gain` argument is NOT its delivered peak
(a low-pass eats energy; non-overlapping notes never sum). So the reference is the **measured
delivered peak** from three rounds of real-browser probing, recorded in AUDIO_DESIGN §0/§0.2
(Chrome) and §0.3 (WeChat). Those figures are read at the SFX bus, i.e. AFTER the per-voice
catalogue gain and AFTER the 0.8 bus gain, so the peak a FILE has to carry is

    file_peak = delivered_peak / (cue_gain * BUS_GAIN)

and `TARGETS` below states both numbers per cue so the division is auditable. Verified against
a cue whose synth voice is a single unfiltered tone: `sfx.ink.tick` authorises gain 0.07, and
0.07 * 0.5 * 0.8 = 0.0280 -- exactly the measured 0.0280. The formula is not a guess.

**The two new gates, both on the SOURCE and both catching defects the output gate cannot see:**

  * `clipped_samples > 0`. Scaling a clipped file DOWN by 15 dB leaves the distortion baked in
    while making `audit.py`'s output check read a clean 0. Six of the picks' near-misses clip
    (`book_275160.ogg` has 1207 clipped samples at 0.18 dBFS), so this is not hypothetical.
  * `attack_ms > cap_ms`. A rustle is a continuous gesture with no onset -- the pool is full of
    files whose peak arrives 240 ms in. Capping such a file at 120 ms cuts it BEFORE its own
    peak, and then peak-matching amplifies the quiet run-up by however much it takes. That
    reads as "the sample is broken" and has no other symptom.

Usage:
    ./venv/Scripts/python process.py [--dry-run]
"""
import argparse, json, os, shutil, sys
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit                                                    # noqa: E402 - local module

SRC = "art/audio/sources"
OUT = "client/src/assets/audio"
CREDITS = "art/audio/credits.json"
RATE_LADDER = [16000, 22050, 24000, 32000, 44100, 48000]

# The SFX bus gain the delivered peaks in AUDIO_DESIGN were measured at -- `DEFAULT_AUDIO_SETTINGS`
# in `audio/audioSettings.ts` (master 1.0 x sfx 0.8). Not a tunable: change it here only if that
# default changes, because every number in TARGETS was read through it.
BUS_GAIN = 0.8

# cue -> (measured delivered peak, catalogue gain). Both are quoted rather than pre-divided so a
# reader can check either against its source of truth: the peaks against AUDIO_DESIGN §0.3's
# table (Chrome column; the two gacha cues with no Chrome figure are not sampled), the gains
# against `client/src/audio/cueCatalogue.ts`.
TARGETS = {
    "sfx.card.play":    (0.1460, 1.00),
    "sfx.card.invalid": (0.1050, 1.00),
    "sfx.unit.attack":  (0.0580, 0.70),
    "sfx.unit.hit":     (0.0980, 0.90),
    "sfx.base.hit":     (0.1510, 1.05),
    "sfx.spell.cast":   (0.1290, 1.00),
    "sfx.unit.death":   (0.0990, 0.85),
    "sfx.ink.tick":     (0.0280, 0.50),
    "sfx.ui.tap":       (0.0923, 1.00),
    "sfx.ui.back":      (0.0706, 1.00),
}

# cue -> (source files, cap ms, why this family). The `why` is the part a measurement cannot
# supply and is copied into credits.json, so a later reader can tell a decision from an accident.
#
# Caps are set from the synth voice being replaced (`audio/audioSynth.ts`), rounded up to leave
# the natural decay somewhere to go: a 90 ms synth stroke gets 140 ms, a 35 ms jab gets 60.
PICKS = {
    "sfx.card.play": (
        ["freesound/stroke_335930.ogg",      # marker-whiteboard-oneshot03, 6849 Hz, attack 12 ms
         "freesound/stroke_761665.ogg",      # Pencil Scribble (9), 3059 Hz
         "freesound/stroke_277312.ogg"],     # Pencil Writing on Paper, 4513 Hz
        140,
        "Single strokes rather than continuous writing takes. Bright (3059-6849 Hz) against the "
        "synth's hp1200/lp7000 noise burst, and one of the three is a marker rather than a "
        "pencil -- marker is one of the game's own three pens (art-direction §3), so the "
        "variant spread carries a little of that instead of three takes of one gesture.",
    ),
    "sfx.card.invalid": (
        ["freesound/eraser_335948.ogg",      # marker-whiteboard-short04, 7135 Hz, attack 3 ms
         "freesound/eraser_335951.ogg",      # marker-whiteboard-short01, 6834 Hz
         "freesound/eraser_538144.ogg"],     # Erase, 2925 Hz -- the dark one, for contrast
        160,
        "THE hole in the free packs: neither Kenney nor BigSoundBank has an eraser at all, and "
        "this cue's whole job is to sound like undoing a mistake. Whiteboard-marker squeaks are "
        "what CC0 has, and they are literally a stationery sound -- the squeak, not the "
        "material, is what reads as 'that did not work'. The dark third variant keeps three "
        "presses of an unaffordable card from sounding like one stuttering file.",
    ),
    "sfx.unit.attack": (
        ["freesound/stroke_632474.ogg",                  # Putting a pencil on paper, 55 ms body
         "bigsoundbank/pencil-signature-3-s3238.mp3"],   # attack 0.1 ms, capped to a jab
        60,
        "The most-emitted cue in the game, so the pick is decided by onset, not timbre: both "
        "files peak within 6 ms of their own start, which is what survives a 60 ms cap. The "
        "second is the first 60 ms of a signature -- a stroke beginning, which is exactly what "
        "a pencil jab is.",
    ),
    "sfx.unit.hit": (
        ["freesound/hit_323725.ogg",         # thunk.wav, 1222 Hz -- closest to the lp2400 puff
         "freesound/hit_13858.ogg",          # 1697 Hz
         "freesound/hit_323721.ogg"],        # drop thunk.wav, 3151 Hz
        120,
        "Muffled single impacts, NOT paper rustles. Every rustle in the pool has a 200-400 ms "
        "attack (a rustle has no onset), which a 120 ms cap would cut before the peak -- see "
        "this file's header. These three land at 1222-3151 Hz against the synth's lp2400 'soft "
        "puff', peak inside 56 ms, and clip nowhere.",
    ),
    "sfx.base.hit": (
        ["freesound/book_332668.ogg"],       # big thud2.wav, 279 Hz, attack 25 ms, mono, no clipping
        250,
        "ONE variant, and that is the measurement's verdict rather than a shortcut: this is the "
        "only file in the whole pool that is simultaneously low enough (279 Hz, against the "
        "synth's 110 Hz sine + lp700), fast enough to peak inside a 250 ms cap, and free of "
        "clipping. The obvious alternatives all fail exactly one of those -- book_275160 is "
        "870 Hz and clean-sounding but carries 1207 clipped samples; book_243400 is clean but "
        "peaks 269 ms in; every `closed-book` take from BigSoundBank clips and sits above "
        "3900 Hz, which is a hardback snapping shut, not a notebook absorbing a blow.",
    ),
    "sfx.spell.cast": (
        ["freesound/page_457767.ogg",        # turnPage.mp3, 3648 Hz
         "freesound/page_397548.ogg",        # Page Turn 01, 3676 Hz
         "bigsoundbank/turned-page-s0164.mp3"],   # 4489 Hz
        400,
        "Page turns, matching the synth's swell + smear two-parter and the design's own 'page "
        "turn + falling-rock smear'. The longest cap in the set (400 ms) because a page turn IS "
        "the gesture -- clipping it short reads as a rustle rather than a turn.",
    ),
    "sfx.unit.death": (
        ["oga-luckius-paper/paper_crushed_-_1.mp3",   # 4939 Hz
         "freesound/crumple_106127.ogg",              # crumple.wav, 5922 Hz
         "freesound/crumple_235754.ogg"],             # Crumple Dry Leaf 2, 6026 Hz
        300,
        "Real crumples replace the synth's four staggered noise grains, which exist only "
        "because one noise burst reads as a puff rather than as paper being balled up. A "
        "recording is granular for free. Dry leaf is in the set deliberately: it is the same "
        "multi-grain crackle and it keeps three deaths in a row from being one file.",
    ),
    "sfx.ink.tick": (
        ["freesound/drop_174718.ogg",        # Single Water Drop, 690 Hz
         "freesound/drop_165206.ogg"],       # Water Drop Sound, 5216 Hz
        120,
        "Single drops, not a dripping-tap ambience. The quietest cue in the set by a wide "
        "margin (target -23 dBFS) because it is a background pulse; two variants because it "
        "fires on a timer and a timer with one sample is a metronome.",
    ),
    "sfx.ui.tap": (
        ["kenney-interface-sounds/Audio/select_002.ogg"],
        60,
        "Kenney Interface Sounds is the one CC0 game-audio pack art-direction §10 does NOT "
        "rule out (its Impact/Sci-Fi/Digital siblings are metal, glass and explosions, i.e. the "
        "forbidden list), and `select` is the pack's own name for a selection blip. One "
        "variant on purpose: a button that answers differently each press reads as "
        "inconsistent, which is the opposite of what this cue is for.",
    ),
    "sfx.ui.back": (
        ["kenney-interface-sounds/Audio/back_002.ogg"],
        120,
        "1833 Hz, the lowest centroid among the pack's clean short files, so leaving a screen "
        "sits UNDER entering one -- the same relationship the synth voice builds with a "
        "downward 620->430 Hz slide. Same one-variant reasoning as `sfx.ui.tap`.",
    ),
}

# Cues that stay on the procedural voice, and why. This is half the deliverable: an empty entry
# in `cueAssets.ts` is indistinguishable from an oversight unless the reason is written down.
KEPT_ON_SYNTH = {
    "sfx.result.victory": "A three-note rising phrase. Its meaning IS the direction, and the "
        "three stingers are designed to share a starting pitch so the player reads the result "
        "from where it goes next -- a found recording cannot carry that relationship, it can "
        "only replace it with someone else's. Measured run-to-run jitter is 1%, so there is no "
        "texture problem to solve either.",
    "sfx.result.defeat": "Same reasoning as `sfx.result.victory`: two notes falling from the "
        "same pitch victory rises from.",
    "sfx.result.draw": "Same reasoning, and the strongest case of the three: the cue is one "
        "pitch repeated with a deliberate GAP, and that gap is the whole semantics ('no "
        "direction'). See audioSynth.ts, which records why the gap must not be closed.",
    "sfx.ui.reward": "A two-note rising chime. Tonal by design (0% measured jitter), and the "
        "CC0 alternatives are digital confirmation blips -- the exact 'soulless app UI' the "
        "art direction is written against.",
    "sfx.ui.gacha.reveal.common": "The three reveal tiers are one voice with notes and "
        "brightness ADDED per tier, so that 'epic' is distinguishable before its third note "
        "lands. That is a relationship between three cues, not three sounds; samples would have "
        "to reproduce it by luck.",
    "sfx.ui.gacha.reveal.rare": "See `sfx.ui.gacha.reveal.common`.",
    "sfx.ui.gacha.reveal.epic": "See `sfx.ui.gacha.reveal.common`.",
    "sfx.ui.error": "A sustained low buzz, and the one KEPT cue where a sample was genuinely "
        "available: Kenney's `error_00x` family is exactly this shape and daydayup ships one. "
        "Rejected anyway on direction -- a digital error buzz is the generic-app sound "
        "art-direction §10 pushes away from, and unlike `sfx.card.invalid` there is no "
        "stationery gesture that means 'the server said no'. Measured jitter is 2%, so the "
        "synth voice is not the weak link here.",
}


def rolloff95(x: np.ndarray, sr: int) -> float:
    n = min(len(x), 1 << 15)
    if n < 64:
        return sr / 4
    mag = np.abs(np.fft.rfft(x[:n] * np.hanning(n)))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    tot = mag.sum()
    if tot <= 1e-12:
        return sr / 4
    return float(freqs[np.searchsorted(np.cumsum(mag) / tot, 0.95)])


def allowed_rates(roll: float) -> list[int]:
    """Ladder rates that keep ~10% headroom above the 95% rolloff."""
    need = roll * 2.2
    ok = [r for r in RATE_LADDER if r >= need]
    return ok or [RATE_LADDER[-1]]


def resample(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out:
        return x
    n_out = int(round(len(x) * sr_out / sr_in))
    spec = np.fft.rfft(x)
    out_bins = n_out // 2 + 1
    new = np.zeros(out_bins, dtype=complex)
    keep = min(len(spec), out_bins)
    new[:keep] = spec[:keep]
    return np.fft.irfft(new, n_out) * (n_out / len(x))


def encode_smallest(y: np.ndarray, sr_in: int, rates: list[int], path: str) -> tuple[int, int]:
    """Encode at every bandwidth-legal rate and keep the smallest file.

    libsndfile's MP3 encoder picks its own VBR quality per sample rate, so bytes are NOT
    monotonic in rate -- one file is smallest at 16 kHz, another at 24 kHz. Measured rather
    than guessed; the search is 4-6 encodes of a sub-second buffer.
    """
    best = None
    for r in rates:
        z = resample(y, sr_in, r)
        tmp = f"{path}.{r}.tmp"
        sf.write(tmp, z, r, format="MP3", subtype="MPEG_LAYER_III")
        n = os.path.getsize(tmp)
        if best is None or n < best[0]:
            if best:
                os.remove(best[2])
            best = (n, r, tmp)
        else:
            os.remove(tmp)
    shutil.move(best[2], path)
    return best[1], best[0]


PRE_ROLL_S = 0.001      # silence kept before the onset, so the file cannot start mid-waveform


def trim(x: np.ndarray, sr: int) -> tuple[np.ndarray, float, float]:
    """Cut leading/trailing silence, keeping 1 ms of pre-roll and fading the new edges.

    **The head fade spans exactly the pre-roll, not 4 ms.** daydayup's version faded 4 ms, and
    that is a real defect this pool exposed: the pre-roll is 1 ms, so the other 3 ms of ramp
    lands on AUDIBLE signal and suppresses the cue's own onset. Three of these 22 assets failed
    `audit.py`'s 5 ms lead-silence gate for that reason alone -- pure added latency, invented by
    the pipeline, on cues whose sources start instantly. The fade exists only so the first
    retained sample is not a discontinuity, and the pre-roll is the whole discontinuity; MP3
    contributes nothing here (libsndfile strips encoder padding -- measured 0.00 ms lead on a
    full-scale onset at all six ladder rates).
    """
    peak = np.max(np.abs(x))
    if peak <= 0:
        return x, 0.0, 0.0
    loud = np.flatnonzero(np.abs(x) > 10 ** (audit.FLOOR_DB / 20) * peak)
    if not loud.size:
        return x, 0.0, 0.0
    pre = max(int(PRE_ROLL_S * sr), 1)
    a = max(int(loud[0]) - pre, 0)
    b = min(int(loud[-1]) + pre, len(x) - 1)
    cut_h, cut_t = a / sr * 1000, (len(x) - 1 - b) / sr * 1000
    y = x[a:b + 1].copy()
    if cut_h > 0.5:
        n = min(pre, len(y))
        y[:n] *= np.linspace(0, 1, n)
    # The tail fade may span signal freely: it replaces a decay that was going to be cut anyway.
    if cut_t > 0.5:
        n = min(int(0.008 * sr), len(y))
        y[-n:] *= np.linspace(1, 0, n)
    return y, cut_h, cut_t


def cap(y: np.ndarray, sr: int, cap_ms: int | None) -> tuple[np.ndarray, float]:
    """Fade out at the cap instead of cutting, so the shortened cue cannot click."""
    if cap_ms is None:
        return y, 0.0
    n = int(sr * cap_ms / 1000)
    if len(y) <= n:
        return y, 0.0
    removed = (len(y) - n) / sr * 1000
    z = y[:n].copy()
    f = min(int(0.02 * sr), len(z))
    z[-f:] *= np.linspace(1, 0, f)
    return z, removed


def target_peak(cue: str) -> tuple[float, float]:
    """(linear file peak this cue's samples must carry, the same in dBFS)."""
    delivered, cue_gain = TARGETS[cue]
    linear = delivered / (cue_gain * BUS_GAIN)
    return linear, audit.db(linear)


def check_source(path: str, cap_ms: int) -> list[str]:
    """Defects that survive the conversion and are INVISIBLE in the output. See the header."""
    m = audit.analyse(path)
    bad = []
    if m["clipped_samples"] > 0:
        bad.append(f"{m['clipped_samples']} clipped samples at {m['peak_dbfs']} dBFS -- "
                   f"scaling down keeps the distortion and hides it from the output gate")
    if m["attack_ms"] is not None and m["attack_ms"] > cap_ms:
        bad.append(f"attack {m['attack_ms']} ms > cap {cap_ms} ms -- the cap would cut this "
                   f"file before its own peak, and peak-matching would then amplify the run-up")
    if m.get("silent"):
        bad.append("silent")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="validate the picks and print the plan without writing anything")
    args = ap.parse_args()

    # Validate before touching the output directory: a typo in PICKS must not leave the shipped
    # set half-written, and `cueAssets.ts` is a build-time import so a missing file is a broken
    # build rather than a silent fallback.
    problems = []
    for cue, (files, cap_ms, _why) in PICKS.items():
        if cue not in TARGETS:
            problems.append(f"{cue}: no peak target")
        for rel in files:
            p = os.path.join(SRC, rel)
            if not os.path.exists(p):
                problems.append(f"{cue}: no such source {rel}")
                continue
            for why in check_source(p, cap_ms):
                problems.append(f"{cue}: {rel}: {why}")
    if problems:
        for p in problems:
            print("REJECT " + p, file=sys.stderr)
        return 1

    if args.dry_run:
        for cue, (files, cap_ms, _why) in PICKS.items():
            lin, dbfs = target_peak(cue)
            print(f"{cue:22} {len(files)} variant(s), cap {cap_ms:4d} ms, "
                  f"target peak {lin:.5f} ({dbfs:+.2f} dBFS)")
        print(f"\n{sum(len(f) for f, _, _ in PICKS.values())} files would be written to {OUT}")
        print(f"{len(KEPT_ON_SYNTH)} cues stay on the synth voice")
        return 0

    os.makedirs(OUT, exist_ok=True)
    for stale in os.listdir(OUT):
        if stale.lower().endswith((".mp3", ".wav", ".ogg")):
            os.remove(os.path.join(OUT, stale))

    report, rows = [], []
    for cue, (files, cap_ms, why) in PICKS.items():
        ref_lin, ref_db = target_peak(cue)
        entries = []
        for i, rel in enumerate(files):
            src = os.path.join(SRC, rel)
            src_bytes = os.path.getsize(src)
            data, sr = sf.read(src, always_2d=True, dtype="float64")
            mono = data.mean(axis=1)

            y, cut_h, cut_t = trim(mono, sr)
            y, capped = cap(y, sr, cap_ms)
            rates = allowed_rates(rolloff95(y, sr))
            peak = float(np.max(np.abs(y)))
            gain = ref_lin / peak if peak > 0 else 1.0
            y = np.clip(y * gain, -1.0, 1.0)

            stem = "%s_%02d" % (cue.replace(".", "-"), i)
            path = os.path.join(OUT, stem + ".mp3")
            out_sr, out_bytes = encode_smallest(y, sr, rates, path)
            entries.append({
                "file": stem + ".mp3",
                "source": rel,
                "source_pack": rel.split("/")[0],
                "source_channels": int(data.shape[1]),
                "sample_rate": out_sr,
                "duration_ms": round(len(y) / sr * 1000, 1),
                "trimmed_ms": round(cut_h + cut_t, 1),
                "capped_ms": round(capped, 1),
                "gain_applied_db": round(20 * np.log10(gain), 2),
                "bytes": out_bytes,
            })
            rows.append((cue, rel, out_sr, entries[-1]["duration_ms"], entries[-1]["capped_ms"],
                         entries[-1]["gain_applied_db"], out_bytes, src_bytes))
        report.append({
            "cue": cue,
            "variants": len(entries),
            "total_bytes": sum(e["bytes"] for e in entries),
            "gate_class": audit.class_for(entries[0]["file"], "sfx"),
            "target_delivered_peak": TARGETS[cue][0],
            "catalogue_gain": TARGETS[cue][1],
            "target_file_peak": round(ref_lin, 5),
            "target_file_peak_dbfs": round(ref_db, 2),
            "cap_ms": cap_ms,
            "rationale": why,
            "files": entries,
        })

    json.dump({
        "note": "Licence and provenance for every audio asset under client/src/assets/audio/. "
                "Upstream pack details are in packs.json. Written by "
                "tools/audio-pipeline/process.py -- edit that, not this.",
        "bus_gain_measured_at": BUS_GAIN,
        "peak_reference": "AUDIO_DESIGN.md §0.3 measured delivered peaks (Chrome column); "
                          "file_peak = delivered_peak / (catalogue_gain * bus_gain)",
        "cues": report,
        "kept_on_synth": KEPT_ON_SYNTH,
        "processing": "mono + trim(-40 dBFS, faded edges) + per-cue duration cap (faded) + "
                      "peak-match to the measured delivered peak + smallest-bytes MP3 among "
                      "bandwidth-legal sample rates (95% rolloff x 2.2).",
    }, open(CREDITS, "w"), indent=1)

    hdr = "%-22s %-42s %6s %8s %8s %8s %8s %8s" % (
        "cue", "source", "sr", "dur ms", "cap ms", "gain dB", "bytes", "src B")
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        print("%-22s %-42s %6d %8.0f %8.0f %+8.2f %8d %8d" % (
            r[0], r[1][:42], r[2], r[3], r[4], r[5], r[6], r[7]))
    total = sum(r[6] for r in rows)
    print(f"\n{len(rows)} files, {total} bytes shipped across {len(report)} cues; "
          f"{len(KEPT_ON_SYNTH)} cues stay on the synth voice. Credits -> {CREDITS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
