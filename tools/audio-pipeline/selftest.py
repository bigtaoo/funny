"""Self-test for the measurement and gating layer. Plain asserts, no pytest.

Ported in spirit from daydayup's `selftest.py`: measurement is checked against SYNTHETIC signals
with known ground truth (a 1 kHz sine must read as a 1 kHz centroid; 50 ms of leading zeros must
read as 50 ms of lead), because a measurement checked against a real file only tells you the
number did not change.

Three things here are pinned specifically because they are decisions this project made and would
silently reverse:

  * `class_for` resolves the LONGEST matching prefix. daydayup shipped a bug where a shorter key
    matched first and held every `pickup.*` asset to the wrong gate; funny's key set has
    `sfx-card`, `sfx-unit-attack` and `sfx-unit-death` living side by side, so the ordering is
    load-bearing rather than incidental.
  * The peak-target arithmetic, against the one cue where it can be checked in closed form:
    `sfx.ink.tick`'s synth voice is a single unfiltered `tone(gain: 0.07)`, and
    0.07 x 0.5 x 0.8 = the 0.0280 measured in a real browser. If `target_peak` ever stops
    reproducing that, every shipped file is mis-scaled and nothing else will say so.
  * `trim`'s head fade spans the pre-roll and NOT 4 ms, which is what stopped the pipeline from
    inventing 3 ms of latency on every asset.

Run: ./venv/Scripts/python selftest.py
"""
import os, sys, tempfile
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit, process

FAILS = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def near(a: float, b: float, tol: float) -> bool:
    return abs(a - b) <= tol


def wav(y: np.ndarray, sr: int, tmp: str, name: str) -> str:
    p = os.path.join(tmp, name)
    sf.write(p, y, sr, subtype="FLOAT")     # FLOAT: no quantisation between write and read
    return p


def tone(sr: int, hz: float, secs: float, amp: float = 0.5) -> np.ndarray:
    n = int(sr * secs)
    return amp * np.sin(2 * np.pi * hz * np.arange(n) / sr)


def main() -> int:
    sr = 48000
    with tempfile.TemporaryDirectory() as tmp:
        print("measurement vs known ground truth")
        m = audit.analyse(wav(tone(sr, 1000, 0.2), sr, tmp, "sine.wav"))
        check("1 kHz sine reads a ~1 kHz centroid", near(m["spectral_centroid_hz"], 1000, 60),
              f"got {m['spectral_centroid_hz']}")
        check("0.2 s reads 200 ms", near(m["duration_ms"], 200.0, 1.0), f"got {m['duration_ms']}")
        check("amp 0.5 reads -6.02 dBFS", near(m["peak_dbfs"], -6.02, 0.05), f"got {m['peak_dbfs']}")
        check("mono reads 1 channel", m["channels"] == 1)
        check("a clean sine reads no clipping", m["clipped_samples"] == 0)

        lead = np.concatenate([np.zeros(int(sr * 0.05)), tone(sr, 1000, 0.1)])
        m = audit.analyse(wav(lead, sr, tmp, "lead.wav"))
        check("50 ms of leading zeros reads 50 ms of lead",
              near(m["lead_silence_ms"], 50.0, 1.5), f"got {m['lead_silence_ms']}")
        check("body excludes the lead", near(m["body_ms"], 100.0, 2.0), f"got {m['body_ms']}")

        # `body_ms` is funny's own addition: the raw source pool is 1-12 s takes whose usable
        # event is 40-300 ms, so gating `duration_ms` would reject the entire pool.
        padded = np.concatenate([np.zeros(int(sr * 0.4)), tone(sr, 1000, 0.05),
                                 np.zeros(int(sr * 0.4))])
        m = audit.analyse(wav(padded, sr, tmp, "padded.wav"))
        check("body_ms ignores padding on both sides", near(m["body_ms"], 50.0, 2.0),
              f"got {m['body_ms']} (duration {m['duration_ms']})")

        loud = np.ones(int(sr * 0.05))
        m = audit.analyse(wav(loud, sr, tmp, "clip.wav"))
        check("full-scale DC reads as clipped", m["clipped_samples"] > 0)
        check("full-scale DC reads a DC offset", m["dc_offset"] > 0.9)

        st = np.stack([tone(sr, 1000, 0.1), tone(sr, 1000, 0.1)], axis=1)
        m = audit.analyse(wav(st, sr, tmp, "dual.wav"))
        check("identical L/R reads as dual-mono", m["lr_identical"] is True)
        check("dual-mono is a gate failure",
              any("lr_identical" in f for f in audit.gate(m, "sfx")))

        m = audit.analyse(wav(np.zeros(int(sr * 0.1)), sr, tmp, "silent.wav"))
        check("all-zero reads silent", m.get("silent") is True)
        check("silent is a gate failure", any("silent" in f for f in audit.gate(m, "sfx")))

        print("\ngate routing (longest prefix wins)")
        for name, want in [
            ("sfx-card-play_00.mp3", "sfx"),
            ("sfx-card-invalid_02.mp3", "sfx"),
            ("sfx-unit-attack_01.mp3", "sfx"),
            ("sfx-unit-hit_00.mp3", "sfx"),
            ("sfx-base-hit_00.mp3", "sfx"),
            ("sfx-ink-tick_01.mp3", "sfx"),
            # These two must NOT inherit `sfx-unit-attack`/`sfx-unit-hit`'s tight combat gate:
            # a crumple and a page turn carry a tail by design.
            ("sfx-unit-death_02.mp3", "feedback"),
            ("sfx-spell-cast_00.mp3", "feedback"),
            ("sfx-result-victory_00.mp3", "feedback"),
            ("sfx-ui-tap_00.mp3", "ui"),
            ("sfx-ui-back_00.mp3", "ui"),
            ("sfx-ui-gacha-reveal-epic_00.mp3", "ui"),
        ]:
            got = audit.class_for(name, "sfx")
            check(f"{name} -> {want}", got == want, f"got {got}")
        check("an unknown name falls back to the caller's default",
              audit.class_for("something-else_00.mp3", "feedback") == "feedback")

        print("\npeak targets")
        # Closed-form check: sfx.ink.tick's synth voice is a single unfiltered tone(gain 0.07).
        lin, dbfs = process.target_peak("sfx.ink.tick")
        check("ink.tick target reproduces the browser-measured 0.0280",
              near(lin * process.TARGETS["sfx.ink.tick"][1] * process.BUS_GAIN, 0.0280, 1e-6),
              f"got {lin * 0.5 * 0.8}")
        check("ink.tick file peak is 0.07 (the voice's own gain)", near(lin, 0.07, 1e-9),
              f"got {lin}")
        check("dBFS agrees with the linear figure", near(dbfs, audit.db(lin), 1e-9))
        for cue in process.PICKS:
            l, _ = process.target_peak(cue)
            check(f"{cue} target is inside the gate's peak window",
                  -30 < audit.db(l) < -0.3, f"got {audit.db(l):.2f} dBFS")

        print("\ntrim / cap")
        # The de-click fade must span the PRE-ROLL, not 4 ms — otherwise it attenuates real
        # signal and shows up as invented lead silence (three of 22 assets failed on this).
        y = np.concatenate([np.zeros(int(sr * 0.05)), tone(sr, 1000, 0.1)])
        t, cut_h, cut_t = process.trim(y, sr)
        pre = int(process.PRE_ROLL_S * sr)
        check("trim cuts the lead down to the pre-roll", near(len(t), int(sr * 0.1) + pre, 3),
              f"got {len(t)} samples")
        check("trim reports what it cut", near(cut_h, 49.0, 2.0), f"got {cut_h}")
        check("the head fade does not reach past the pre-roll",
              abs(t[pre + 5]) > 0.4 * 0.5,
              f"sample just after the pre-roll is {t[pre + 5]:.4f}, expected near full amplitude")
        check("trim preserves the peak", near(float(np.max(np.abs(t))), 0.5, 1e-6))

        capped, removed = process.cap(tone(sr, 1000, 0.3), sr, 100)
        check("cap shortens to the cap", near(len(capped) / sr * 1000, 100.0, 1.0),
              f"got {len(capped) / sr * 1000}")
        check("cap reports what it removed", near(removed, 200.0, 1.0), f"got {removed}")
        check("cap fades out rather than cutting", abs(capped[-1]) < 1e-3,
              f"last sample {capped[-1]:.5f}")
        short, removed = process.cap(tone(sr, 1000, 0.05), sr, 100)
        check("cap leaves a file already under the cap alone", removed == 0.0 and len(short) == int(sr * 0.05))

        print("\nrate ladder")
        check("a 2 kHz rolloff allows every ladder rate",
              process.allowed_rates(2000)[0] == 16000)
        check("a 12 kHz rolloff forces 32 kHz or above",
              min(process.allowed_rates(12000)) >= 32000,
              f"got {process.allowed_rates(12000)}")
        check("an absurd rolloff still returns a rate rather than an empty list",
              process.allowed_rates(1e6) == [48000])
        r = process.resample(tone(sr, 1000, 0.1), sr, 24000)
        check("resample halves the sample count at half the rate", near(len(r), 2400, 2),
              f"got {len(r)}")
        check("resample preserves amplitude", near(float(np.max(np.abs(r))), 0.5, 0.02),
              f"got {float(np.max(np.abs(r)))}")

        print("\nsource rejection (defects invisible in the output)")
        clipped = wav(np.ones(int(sr * 0.05)) * 1.0, sr, tmp, "src-clip.wav")
        check("a clipped source is rejected",
              any("clipped" in w for w in process.check_source(clipped, 100)))
        # A slow SWELL, not a quiet lead followed by a bang. The first version of this case used
        # the latter and did not reproduce: `attack_ms` counts from the first sample above
        # -40 dBFS-relative, so a lead sitting 54 dB down is simply not part of the attack. What
        # the gate is actually for is the pool's paper rustles — a continuous gesture that is
        # audible from the start and peaks 200-400 ms in.
        swell = tone(sr, 1000, 0.3) * np.linspace(0.05, 1.0, int(sr * 0.3))
        p_slow = wav(swell, sr, tmp, "src-slow.wav")
        check("a source whose peak lands past the cap is rejected",
              any("attack" in w for w in process.check_source(p_slow, 100)),
              f"got {process.check_source(p_slow, 100)}")
        clean = wav(tone(sr, 1000, 0.08), sr, tmp, "src-clean.wav")
        check("a clean, fast source is accepted", process.check_source(clean, 100) == [])

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
