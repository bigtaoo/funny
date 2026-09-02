"""Objective audio-asset audit: measures what can be measured, gates on AUDIO_DESIGN's
constraints, and stays silent about taste. A defect finder, not a critic.

Ported from daydayup's `tools/audio-pipeline/audit.py` (2026-09-01).

`music` and its band/crossfade measures arrived 2026-09-01 with AUDIO_DESIGN §7 step 7 --
the header used to say they were deliberately left behind because "an unused gate class is a
rule nobody can be failing", and they came across the moment there were tracks to hold.

**`loop` did NOT come with them, and that is a decision rather than an omission.** daydayup
ships both classes; its `loop` gate requires `step_db <= -50`, i.e. the last sample of the file
sitting next to the first, which is what `el.loop = true` needs. `MusicPlayer` here does not use
native looping -- MP3 frame padding makes sample-exact wrapping unavailable no matter how the
region is cut, so the player crossfades a second deck over the tail instead (see that file's
header). `xfade_band_diff` is therefore the measure that decides whether a wrap is audible, and
`step_db` would be a gate held against a mechanism this client does not have.

Usage:
    ./venv/Scripts/python audit.py <file-or-dir>... [--class sfx|feedback|ui|music] [--json out.json]
    ./venv/Scripts/python audit.py client/src/assets/audio --by-cue
"""
import argparse, json, os, sys
import numpy as np
import soundfile as sf

FLOOR_DB = -40.0          # "signal starts here" threshold for silence trimming
CLIP_LEVEL = 0.9995


def db(x: float) -> float:
    return -np.inf if x <= 1e-12 else 20.0 * np.log10(x)


def spectral(mono: np.ndarray, sr: int) -> tuple[float, float]:
    """Spectral centroid and 95% rolloff over the whole (windowed) signal, in Hz."""
    n = min(len(mono), 1 << 15)
    if n < 64:
        return 0.0, 0.0
    seg = mono[:n] * np.hanning(n)
    mag = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    total = mag.sum()
    if total <= 1e-12:
        return 0.0, 0.0
    centroid = float((freqs * mag).sum() / total)
    cdf = np.cumsum(mag) / total
    rolloff = float(freqs[np.searchsorted(cdf, 0.95)])
    return centroid, rolloff


# ── Log-band analysis (BGM only, AUDIO_DESIGN §7 step 7) ─────────────────────────────────────
#
# A single spectral CENTROID (spectral() above) is enough to compare two 100 ms cues and far too
# coarse to say whether two 2 s windows of a 60 s bed will wrap without lurching -- daydayup
# measured 0.945 on a candidate where the per-band measure read 2.4 dB.
BAND_N, BAND_LO, BAND_HI = 30, 40.0, 16000.0
BAND_FLOOR_DB = -120.0     # an EMPTY band must read a number: -inf - -inf = nan downstream

# `MusicPlayer`'s crossfade length, seconds, and the width of the window this measure compares.
# **Shared with `client/src/audio/musicCatalogue.ts`'s `XFADE_S` and must not be changed on one
# side alone**: the shipped tracks are accepted on the tonal compatibility of exactly this
# window, so widening it here judges them on a window nobody measured. `musicAssets.test.ts`
# asserts the two numbers agree.
XFADE_S = 2.0

# The mid band: 250-2000 Hz, where every shipped cue's peak lives. It is the one band that
# decides whether combat still reads over the bed, which is why level is set by it (see
# `process_music.py`'s MID_TARGET_DBFS) rather than by peak.
MID_BAND = (250.0, 2000.0)


def band_edges() -> np.ndarray:
    return np.geomspace(BAND_LO, BAND_HI, BAND_N + 1)


def band_profile(x: np.ndarray, sr: int) -> np.ndarray:
    """Per-band RMS in dBFS over BAND_N log-spaced bands, floored at BAND_FLOOR_DB.

    Accepts mono or (n, ch) -- `process_music.py` measures stereo regions with these.
    """
    mono = x.mean(axis=1) if x.ndim > 1 else x
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    edges = band_edges()
    out = np.full(BAND_N, BAND_FLOOR_DB)
    n = len(mono)
    # Parseval, one-sided: 2*sum|X_k|^2 / n^2 is the mean square of the band-limited signal.
    for b in range(BAND_N):
        sel = (freqs >= edges[b]) & (freqs < edges[b + 1])
        if sel.any():
            ms = 2.0 * float(np.sum(np.abs(spec[sel]) ** 2)) / (n * n)
            out[b] = max(db(np.sqrt(ms)), BAND_FLOOR_DB)
    return out


def band_rms(x: np.ndarray, sr: int, lo: float, hi: float) -> float:
    """RMS of the signal restricted to [lo, hi), in dBFS, over the whole signal."""
    mono = x.mean(axis=1) if x.ndim > 1 else x
    spec = np.fft.rfft(mono)
    freqs = np.fft.rfftfreq(len(mono), 1.0 / sr)
    spec[(freqs < lo) | (freqs >= min(hi, sr / 2.0))] = 0
    y = np.fft.irfft(spec, len(mono))
    return db(float(np.sqrt(np.mean(y ** 2))))


def profile_diff(a: np.ndarray, b: np.ndarray) -> float:
    """Energy-weighted mean |dB| difference between two band profiles.

    ONE function, because this quantity is used twice: to RANK candidate loop regions
    (`process_music.py --search`) and to ACCEPT the shipped file (the `music` gate). daydayup
    let those drift apart three separate times -- different window resolutions (a region ranked
    3.01 dB measured 5.61 dB), weighted vs unweighted (2.44 -> 3.39 dB), and searching the raw
    master while gating the shelved file (1.41 -> 3.69 dB). Each time the symptom was the same:
    a search that keeps handing back candidates which do not survive acceptance. The rule those
    three cost is **the search metric must literally be the acceptance metric**, which is only
    enforceable if there is one function.
    """
    weight = 10.0 ** (np.maximum(a, b) / 10.0)
    total = float(weight.sum())
    if total <= 0.0:
        return 0.0
    return float(np.sum(weight * np.abs(b - a)) / total)


def xfade_band_diff(x: np.ndarray, sr: int, xfade_s: float = XFADE_S) -> float:
    """Per-band dB difference between the head and tail crossfade windows, ENERGY-WEIGHTED.

    The weighting is not a refinement, it is what makes the measure mean anything. An unweighted
    mean over 30 bands gives a band sitting at -100 dBFS the same vote as the one carrying the
    music, and in a band holding no signal the only thing left is FFT leakage whose phase
    differs between the two windows. daydayup measured a two-sine bed whose head and tail were
    *identical by construction* at 6.12 dB unweighted -- enough to fail a 3.5 dB gate on nothing
    at all. Weighting each band by the louder of its two windows makes the number mean "how
    different are the parts you can hear", which is the question a crossfade poses.
    """
    w = int(xfade_s * sr)
    if len(x) < 4 * w:
        return float("nan")
    return profile_diff(band_profile(x[:w], sr), band_profile(x[-w:], sr))


def music_measures(mono: np.ndarray, sr: int) -> dict:
    """The two numbers the `music` gate is about, or Nones when the file is too short.

    Returning Nones rather than raising is what lets `analyse` call this unconditionally: every
    cue in this repo is under 400 ms, i.e. far under the 4x-crossfade-window minimum, so the
    early return fires immediately and the 22-file cue sweep pays nothing.
    """
    w = int(XFADE_S * sr)
    if len(mono) < 4 * w:
        return {"xfade_band_diff": None, "mid_band_dbfs": None}
    return {
        "xfade_band_diff": round(xfade_band_diff(mono, sr), 2),
        "mid_band_dbfs": round(band_rms(mono, sr, *MID_BAND), 2),
    }


def analyse(path: str) -> dict:
    data, sr = sf.read(path, always_2d=True, dtype="float64")
    ch = data.shape[1]
    mono = data.mean(axis=1)
    n = len(mono)
    peak = float(np.max(np.abs(data))) if n else 0.0
    env = np.abs(mono)
    floor = 10 ** (FLOOR_DB / 20.0) * max(peak, 1e-9)
    loud = np.flatnonzero(env > floor)

    out = {
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path),
        "sample_rate": sr,
        "channels": ch,
        "duration_ms": round(1000.0 * n / sr, 1),
        "peak_dbfs": round(db(peak), 2),
        "peak_linear": round(peak, 5),
        "rms_dbfs": round(db(float(np.sqrt(np.mean(mono ** 2)))), 2) if n else None,
        "dc_offset": round(float(np.mean(mono)), 5),
        "clipped_samples": int(np.count_nonzero(np.abs(data) >= CLIP_LEVEL)),
    }
    out["kbps"] = round(out["bytes"] * 8 / max(out["duration_ms"], 1e-6), 1)

    if loud.size:
        out["lead_silence_ms"] = round(1000.0 * int(loud[0]) / sr, 1)
        out["tail_silence_ms"] = round(1000.0 * (n - 1 - int(loud[-1])) / sr, 1)
        # Attack: onset -> peak. A punchy impact is a couple of ms; a soft pad is 100+.
        pk = int(np.argmax(env))
        out["attack_ms"] = round(1000.0 * max(pk - int(loud[0]), 0) / sr, 1)
        # Body: onset -> last loud sample. What the cue costs after trimming, which is the
        # number that has to fit the gate -- `duration_ms` on a raw library file is mostly
        # room tone. Added for funny: the BigSoundBank pool ships 1-12 s takes of which the
        # usable event is 40-300 ms, so gating raw duration would reject every candidate.
        out["body_ms"] = round(1000.0 * (int(loud[-1]) - int(loud[0]) + 1) / sr, 1)
    else:
        out["lead_silence_ms"] = out["tail_silence_ms"] = out["attack_ms"] = None
        out["body_ms"] = None
        out["silent"] = True

    out["crest_db"] = (
        round(out["peak_dbfs"] - out["rms_dbfs"], 2)
        if out["rms_dbfs"] not in (None, -np.inf) else None
    )
    c, r = spectral(mono, sr)
    out["spectral_centroid_hz"], out["spectral_rolloff95_hz"] = round(c), round(r)
    out.update(music_measures(mono, sr))

    if ch == 2:
        l, r_ = data[:, 0], data[:, 1]
        out["lr_identical"] = bool(np.allclose(l, r_, atol=1e-4))
        sl, sr_ = l.std(), r_.std()
        out["lr_correlation"] = (
            round(float(np.corrcoef(l, r_)[0, 1]), 3) if sl > 1e-9 and sr_ > 1e-9 else None
        )
    return out


# Gates come from AUDIO_DESIGN §2 (cue table) + §5 (platform constraints).
#
# The peak window deliberately spans -30..-0.3 dBFS. daydayup learned this the expensive way:
# a -12 dBFS floor spuriously failed 40 of 46 assets that had been peak-matched DOWN to the
# quiet synth voices they replace. funny's peak targets are lower still (see process.py --
# `sfx.ink.tick` lands at -23 dBFS), so the floor exists only to catch an inaudible file.
#
# Duration is gated on `body_ms`, not `duration_ms`: these run on the SHIPPED files, which are
# already trimmed, and holding a raw 6-second library take to a 500 ms cap would reject the
# whole pool before the pipeline ever got to trim it.
#
# `sfx` is for combat cues that must feel instant (card/attack/hit/base).
# `feedback` is for cues where a few ms of onset costs nothing (death/spell/result stingers).
#
# **The lead-silence allowance is one rendered frame (16 ms), not daydayup's 5 ms.** That is a
# calibration difference, not a loosening: 5 ms was set against synthetic one-shots that begin at
# full scale, and this project's cues are dispatched by `EventsPanel.flushAudio()`, which runs
# ONCE PER FRAME after the engine's event loop -- so every battle cue already carries 0-16.7 ms
# of quantisation to the frame clock before `playSfx` is even called. A 5 ms budget inside the
# sample sits below the noise floor of the system's own timing.
#
# The measurement that made this concrete: `eraser_335951.ogg` reads 8.94 ms of lead, all of it
# at about -58 dBFS -- 40 dB under the cue's own peak, i.e. inaudible run-up that belongs to the
# recording of a marker squeak. A -40 dB RELATIVE floor cannot tell that apart from real added
# latency, and it is fragile at the boundary: in memory the file reads 1.00 ms because a single
# sample sat 0.00007 above the threshold, and PCM_16 quantisation moved it 0.00001 below.
GATES = {
    "sfx": [
        ("body_ms", None, 500, "combat cue too long -- long tails pile up under VoiceBudget"),
        ("lead_silence_ms", None, 16, "onset arrives more than a frame late -- real added latency, "
                                      "not the frame quantisation every cue already has"),
        ("peak_dbfs", -30, -0.3, "peak outside usable range (inaudible / too hot to mix)"),
        ("clipped_samples", None, 0, "clipped -- will distort further once the SFX bus sums voices"),
        ("channels", None, 1, "stereo SFX doubles bytes for no positional gain (game pans in code)"),
    ],
    "feedback": [
        ("body_ms", None, 800, "feedback cue outlasting its moment"),
        ("lead_silence_ms", None, 20, "onset late enough to feel disconnected from the event"),
        ("peak_dbfs", -30, -0.3, "peak outside usable range (inaudible / too hot to mix)"),
        ("clipped_samples", None, 0, "clipped"),
        ("channels", None, 1, "stereo cue wastes bytes"),
    ],
    "ui": [
        ("body_ms", None, 350, "UI click should not outlast the interaction"),
        # Half a frame, i.e. stricter than the combat gate on purpose: a button press is the
        # most latency-sensitive event in the game, and the whole cue is only ~43 ms long.
        ("lead_silence_ms", None, 8, "leading silence makes a button feel unresponsive"),
        ("peak_dbfs", -30, -0.3, "peak outside usable range"),
        ("clipped_samples", None, 0, "clipped"),
        ("channels", None, 1, "stereo UI cue wastes bytes"),
    ],
    # BGM (AUDIO_DESIGN §2.3 / §7 step 7, 2026-09-01). Three of its five rules exist because a
    # bed is not a cue, and each difference is a design decision rather than a looser number:
    #
    #  * **No `channels` limit.** The sfx/ui gates forbid stereo because a 43 ms cue's second
    #    channel is pure overhead and doubles a file the game holds decoded in RAM. A 60 s bed
    #    STREAMS (`MusicPlayer` never puts it in the `SampleBank`), so neither argument applies.
    #  * **No `step_db`.** See this file's header: the player crossfades the wrap, so head and
    #    tail are heard TOGETHER and only have to be tonally compatible -- which is what
    #    `xfade_band_diff` measures, over exactly the window the player fades across.
    #  * **Level is gated on a BAND, not on peak.** Every cue in this repo was peak-matched to
    #    the synth voice it replaced (§0.4); music has no synth voice to match, so the anchor is
    #    the 250-2000 Hz RMS -- the band every cue peaks in.
    #
    # WHERE -29 COMES FROM. It is derived from this repo's own measured cue set, not copied from
    # daydayup's -30 (whose cues are ~2 dB louder on file and carry different catalogue gains).
    # Delivered cue peak = file peak x CUE_CATALOGUE gain x 0.8 (the SFX bus, §4); delivered bed
    # mid-band RMS = file mid x 1.0 (track gain) x 0.5 (the BGM bus default, §4). At -29 dBFS on
    # file the bed delivers -35.0, and the cues stand above it by:
    #
    #     base.hit +18.6   card.play +18.3   spell.cast +17.2   card.invalid +15.4
    #     unit.death +14.9   unit.hit +14.8   ui.tap +14.3   ui.back +12.0
    #     unit.attack +10.3   ink.tick +4.0      (dB)
    #
    # That ladder is not hand-arithmetic: `process_music.py --track ...` prints it from
    # `process.py`'s TARGETS (the MEASURED delivered peaks) after every run, so a track whose
    # level drifts still has to show it. Reproduce it with `headroom_report(-29.0)`.
    #
    # The binding constraint is `sfx.unit.attack` at +10.3 dB: the most-fired battle cue, and
    # deliberately the quietest of the ones that must stay LEGIBLE (catalogue gain 0.7, "受击
    # 0.9 明显高于攻击 0.7"). `sfx.ink.tick` is excluded from that rule on purpose -- it is
    # authored as the faintest thing in the game and is already throttled to one tick per 10 ink
    # (§0.1), so holding the bed to 10 dB under IT would put the music 6 dB lower than anything
    # else in the mix justifies.
    #
    # **This number is a prediction that nobody has heard.** It is the same class of claim as
    # every figure in §0.1-§0.4: it says the bed is correctly PLACED, not that it sounds good
    # underneath a match. Only the listening pass settles that.
    "music": [
        ("duration_ms", 20000, 90000, "loop outside 20-90s -- shorter tires the ear, longer "
                                      "spends download budget on material nobody hears twice"),
        ("xfade_band_diff", None, 2.5, "head and tail differ tonally across the crossfade -- "
                                       "the wrap will lurch"),
        ("mid_band_dbfs", -30.0, -28.0, "250-2000 Hz level off target: combat/UI cues stop "
                                        "reading over the bed (see the derivation above)"),
        ("peak_dbfs", -26, -3.0, "peak outside usable range (inaudible / no headroom over the "
                                 "cue set)"),
        ("clipped_samples", None, 0, "clipped"),
        # NOT a package-size rule: every audio file in this repo ships on the CDN and none of
        # them touches the 4 MB WeChat main package (§5's struck-out "首包体积" row). This is a
        # DOWNLOAD budget -- a bed is 20-90 s where a cue is 43-400 ms, so it is the only audio
        # asset whose bitrate can matter to a player on mobile data.
        ("kbps", None, 128, "over budget for a streamed bed on mobile data"),
    ],
}

# Which gate a shipped asset is held to, keyed by the cue-name prefix of its filename.
# Shipped names flatten the cue id's dots to dashes (`sfx.unit.hit` -> `sfx-unit-hit_00.mp3`),
# so the lookup is on the dashed form.
CUE_CLASS = {
    "sfx-card": "sfx",
    "sfx-unit-attack": "sfx",
    "sfx-unit-hit": "sfx",
    "sfx-base": "sfx",
    "sfx-ink": "sfx",
    # Death and spell carry a natural tail (a crumple, a page turn); the result stingers are
    # the longest cues in the set by design. None of them is on the critical latency path.
    "sfx-unit-death": "feedback",
    "sfx-spell": "feedback",
    "sfx-result": "feedback",
    # One prefix covers every screen-layer cue, so a nineteenth `sfx.ui.*` inherits the gate
    # instead of falling through to the caller's default.
    "sfx-ui": "ui",
}


def class_for(filename: str, default: str) -> str:
    """Pick the gate from a shipped asset's name (`sfx-unit-hit_02.mp3` -> sfx).

    DIRECTORY FIRST. A track ships as `assets/audio/music/<track>.mp3` -- a name with no cue
    prefix at all, which would fall through to the caller's default and hold a 60 s stereo bed
    to the COMBAT gate ("too long", "stereo wastes bytes", peak far outside the cue window).
    Routing on the directory instead of the name means a track added later cannot inherit the
    wrong gate by being named badly, and it matches how every other decision about a music file
    is already made -- `musicCatalogue.ts` groups them by directory too.

    Then longest prefix wins: `sfx-unit-death` must beat `sfx-unit-attack`'s neighbours and
    `sfx-card` must not swallow a future `sfx-card-something-else`. Sorting by length is what
    makes adding a cue safe -- daydayup shipped a bug here where every `pickup.*` asset was
    held to the combat gate because the prefix scan hit a shorter key first.
    """
    if "music" in os.path.normpath(filename).replace("\\", "/").split("/")[:-1]:
        return "music"
    stem = os.path.splitext(os.path.basename(filename))[0]
    name = stem.rsplit("_", 1)[0] if "_" in stem else stem
    for prefix in sorted(CUE_CLASS, key=len, reverse=True):
        if name == prefix or name.startswith(prefix + "-"):
            return CUE_CLASS[prefix]
    return default


def gate(m: dict, cls: str) -> list[str]:
    fails = []
    for key, lo, hi, why in GATES[cls]:
        v = m.get(key)
        if v is None:
            continue
        if lo is not None and v < lo:
            fails.append(f"{key}={v} < {lo}: {why}")
        if hi is not None and v > hi:
            fails.append(f"{key}={v} > {hi}: {why}")
    if m.get("silent"):
        fails.append("silent: no sample above -40 dBFS")
    if abs(m.get("dc_offset") or 0) > 0.01:
        fails.append(f"dc_offset={m['dc_offset']}: DC bias, clicks on start/stop")
    if m.get("lr_identical"):
        fails.append("lr_identical: dual-mono -- halve the bytes by shipping mono")
    return fails


AUDIO_EXTS = {".wav", ".ogg", ".mp3", ".flac", ".aiff", ".aif"}


def collect(paths: list[str]) -> list[str]:
    files: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, names in os.walk(p):
                files += [os.path.join(root, n) for n in sorted(names)
                          if os.path.splitext(n)[1].lower() in AUDIO_EXTS]
        else:
            files.append(p)
    return files


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--class", dest="cls", default="sfx", choices=list(GATES))
    ap.add_argument("--by-cue", action="store_true",
                    help="pick the gate per file from its cue name instead of --class")
    ap.add_argument("--no-gate", action="store_true",
                    help="measure only; for surveying a raw source pool that no gate fits yet")
    ap.add_argument("--json", dest="json_out")
    args = ap.parse_args()

    rows, failed = [], 0
    for f in collect(args.paths):
        try:
            m = analyse(f)
        except Exception as e:                                   # noqa: BLE001 - report, continue
            print(f"ERROR {f}: {e}", file=sys.stderr)
            failed += 1
            continue
        m["path"] = f.replace(os.sep, "/")
        if not args.no_gate:
            cls = class_for(f, args.cls) if args.by_cue else args.cls
            m["gate_class"] = cls
            m["fails"] = gate(m, cls)
        rows.append(m)

    # The two music columns appear only when something in the run actually has them. Printing
    # them always would add two "-" columns to every cue sweep; leaving them out always would
    # hide the two numbers the `music` gate is entirely about, which is exactly the case where
    # a FAIL is unreadable without them.
    has_music = any(m.get("mid_band_dbfs") is not None for m in rows)
    cols = "%-42s %6s %5s %8s %8s %8s %7s %7s %7s" + (" %8s %8s" if has_music else "%.0s%.0s")
    hdr = cols % ("file", "sr", "ch", "dur ms", "body ms", "peak dB", "attack", "centroid",
                  "bytes", "mid dB", "xfade dB")
    print(hdr)
    print("-" * len(hdr))
    for m in rows:
        row = "%-42s %6d %5d %8.0f %8s %8.2f %7s %7s %7d" % (
            m["file"][:42], m["sample_rate"], m["channels"], m["duration_ms"],
            m["body_ms"] if m["body_ms"] is not None else "-", m["peak_dbfs"],
            m["attack_ms"] if m["attack_ms"] is not None else "-",
            m["spectral_centroid_hz"], m["bytes"])
        if has_music:
            row += " %8s %8s" % (
                m["mid_band_dbfs"] if m["mid_band_dbfs"] is not None else "-",
                m["xfade_band_diff"] if m["xfade_band_diff"] is not None else "-")
        print(row)

    # Written BEFORE the gate verdict decides the exit code: the run that FAILS is exactly the
    # run whose numbers you want to read.
    if args.json_out:
        json.dump(rows, open(args.json_out, "w"), indent=1)

    if not args.no_gate:
        bad = [m for m in rows if m["fails"]]
        print()
        for m in bad:
            print(f"FAIL {m['file']} [{m['gate_class']}]")
            for why in m["fails"]:
                print(f"     {why}")
        print(f"{len(rows) - len(bad)}/{len(rows)} pass" + (f", {failed} unreadable" if failed else ""))
        if bad or failed:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
