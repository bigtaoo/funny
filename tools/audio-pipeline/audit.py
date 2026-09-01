"""Objective audio-asset audit: measures what can be measured, gates on AUDIO_DESIGN's
constraints, and stays silent about taste. A defect finder, not a critic.

Ported from daydayup's `tools/audio-pipeline/audit.py` (2026-09-01), minus the `loop`/`music`
gate classes and the band/crossfade measures that only exist to serve them -- funny has no BGM
yet (AUDIO_DESIGN §7 step 7). When BGM lands, those come across with it; until then an unused
gate class is a rule nobody can be failing.

Usage:
    ./venv/Scripts/python audit.py <file-or-dir>... [--class sfx|feedback|ui] [--json out.json]
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

    Longest prefix wins: `sfx-unit-death` must beat `sfx-unit-attack`'s neighbours and
    `sfx-card` must not swallow a future `sfx-card-something-else`. Sorting by length is what
    makes adding a cue safe -- daydayup shipped a bug here where every `pickup.*` asset was
    held to the combat gate because the prefix scan hit a shorter key first.
    """
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

    hdr = "%-42s %6s %5s %8s %8s %8s %7s %7s %7s" % (
        "file", "sr", "ch", "dur ms", "body ms", "peak dB", "attack", "centroid", "bytes")
    print(hdr)
    print("-" * len(hdr))
    for m in rows:
        print("%-42s %6d %5d %8.0f %8s %8.2f %7s %7s %7d" % (
            m["file"][:42], m["sample_rate"], m["channels"], m["duration_ms"],
            m["body_ms"] if m["body_ms"] is not None else "-", m["peak_dbfs"],
            m["attack_ms"] if m["attack_ms"] is not None else "-",
            m["spectral_centroid_hz"], m["bytes"]))

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
