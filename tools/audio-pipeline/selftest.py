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
import json, os, re, sys, tempfile
import numpy as np
import soundfile as sf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import audit, process, process_music

FAILS = []

# The shipped record, so a few cases can check the tables against what was actually written from
# them. Absent before the first `process.py` run (and when this file is run from a checkout whose
# assets have not been generated), which is a legitimate state -- those cases are then SKIPPED
# rather than failed, and say so, because "the record disagrees" and "there is no record" are
# different findings and only the first is a defect.
_HAS_CREDITS = os.path.exists(process.CREDITS)
_CREDITS = json.load(open(process.CREDITS)) if _HAS_CREDITS else {"cues": [], "kept_on_synth": {}}


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        print(f"  FAIL {name} {detail}")
        FAILS.append(name)


def check_shipped(name: str, cond: bool, detail: str = "") -> None:
    """A check that needs `credits.json` on disk. Skipped, loudly, when it is not there."""
    if not _HAS_CREDITS:
        print(f"  skip {name} (no {process.CREDITS} -- run process.py first)")
        return
    check(name, cond, detail)


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

        print("\nencode_smallest (the byte-budget search)")
        # Not a formality: this search is why the shipped set is 57.6 KB rather than whatever
        # 48 kHz would have cost. libsndfile's MP3 encoder picks its own VBR quality per rate, so
        # bytes are NOT monotonic in rate -- if this ever silently stopped comparing and just took
        # the first (lowest) rate, the files would still play and still pass every other check.
        y = tone(sr, 1000, 0.12)
        rates = [16000, 22050, 24000, 32000, 44100, 48000]
        chosen_path = os.path.join(tmp, "enc.mp3")
        chosen_rate, chosen_bytes = process.encode_smallest(y, sr, rates, chosen_path)
        check("encode_smallest returns a rate from the list it was given", chosen_rate in rates,
              f"got {chosen_rate}")
        check("it leaves exactly one file at the target path and no .tmp siblings",
              os.path.exists(chosen_path)
              and not [f for f in os.listdir(tmp) if f.startswith("enc.mp3.")],
              f"stray: {[f for f in os.listdir(tmp) if f.startswith('enc.mp3.')]}")
        check("the reported byte count is the file's actual size",
              chosen_bytes == os.path.getsize(chosen_path),
              f"reported {chosen_bytes}, on disk {os.path.getsize(chosen_path)}")
        # The claim under test: nothing in the list encodes smaller than what it picked.
        sizes = {}
        for r in rates:
            p = os.path.join(tmp, f"probe_{r}.mp3")
            sf.write(p, process.resample(y, sr, r), r, format="MP3", subtype="MPEG_LAYER_III")
            sizes[r] = os.path.getsize(p)
        check("it actually picked the smallest, not merely a valid one",
              chosen_bytes == min(sizes.values()),
              f"picked {chosen_rate}@{chosen_bytes}, smallest is "
              f"{min(sizes, key=sizes.get)}@{min(sizes.values())}")
        check("a single-rate list is a no-op search rather than an error",
              process.encode_smallest(y, sr, [24000], os.path.join(tmp, "one.mp3"))[0] == 24000)
        check_shipped("the shipped set really does span several rates (else the search is dead weight)",
              len({f["sample_rate"] for c in _CREDITS["cues"] for f in c["files"]}) > 1,
              "every shipped file has the same sample rate")

        print("\ntables agree with each other")
        check("every picked cue has a peak target",
              set(process.PICKS) <= set(process.TARGETS),
              f"missing: {sorted(set(process.PICKS) - set(process.TARGETS))}")
        check("no peak target is left over from a cue that stopped being picked",
              set(process.TARGETS) == set(process.PICKS),
              f"extra: {sorted(set(process.TARGETS) - set(process.PICKS))}")
        check("nothing is both picked and kept on the synth voice",
              not (set(process.PICKS) & set(process.KEPT_ON_SYNTH)),
              f"both: {sorted(set(process.PICKS) & set(process.KEPT_ON_SYNTH))}")
        check("every PICKS entry names at least one source file",
              all(files for files, _cap, _why in process.PICKS.values()))
        check("every PICKS entry carries a rationale, not a placeholder",
              all(len(why) > 60 for _f, _c, why in process.PICKS.values()))
        # Same allowance the TS-side gate makes (`client/test/audio/audioAssets.test.ts`): a
        # `See \`<cue>\`.` pointer is legitimate where several cues share ONE decision -- the three
        # gacha reveal tiers are a single judgement about the relationship between them, and
        # writing it out three times makes the record worse. But the pointer has to resolve, and
        # what it resolves TO has to be a real reason. Keeping the two gates' definitions of
        # "placeholder" identical matters: a rule that is stricter in Python than in CI just means
        # the Python one gets edited away the first time it fires.
        def synth_reason_ok(cue: str, why: str, depth: int = 0) -> bool:
            ref = re.fullmatch(r"See `([^`]+)`\.", why)
            if not ref:
                return len(why) > 60
            target = ref.group(1)
            if target == cue or depth > 2 or target not in process.KEPT_ON_SYNTH:
                return False
            return synth_reason_ok(target, process.KEPT_ON_SYNTH[target], depth + 1)

        bad_reasons = [c for c, why in process.KEPT_ON_SYNTH.items() if not synth_reason_ok(c, why)]
        check("every KEPT_ON_SYNTH entry carries a real reason or a resolving cross-reference",
              not bad_reasons, f"placeholders: {bad_reasons}")
        check("a cross-reference to nowhere is rejected",
              not synth_reason_ok("sfx.ui.reward", "See `sfx.nope`."))
        check("a self-reference is rejected",
              not synth_reason_ok("sfx.ui.reward", "See `sfx.ui.reward`."))
        check_shipped("credits.json on disk matches the tables it was written from",
              {c["cue"] for c in _CREDITS["cues"]} == set(process.PICKS)
              and set(_CREDITS["kept_on_synth"]) == set(process.KEPT_ON_SYNTH),
              "re-run process.py")

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
        silent = wav(np.zeros(int(sr * 0.1)), sr, tmp, "src-silent.wav")
        check("a silent source is rejected",
              any("silent" in w for w in process.check_source(silent, 100)),
              f"got {process.check_source(silent, 100)}")
        clean = wav(tone(sr, 1000, 0.08), sr, tmp, "src-clean.wav")
        check("a clean, fast source is accepted", process.check_source(clean, 100) == [])
        check("every source the shipped set was built from still passes both source gates",
              not [f"{cue}:{rel}:{w}"
                   for cue, (files, cap_ms, _why) in process.PICKS.items()
                   for rel in files
                   for w in process.check_source(os.path.join(process.SRC, rel), cap_ms)],
              "a source under art/audio/sources/ changed or went missing")

    # ── BGM: band measurement, the shelf, and the `music` gate ───────────────────────────────
    #
    # Every measurement below is checked against a signal whose right answer is known
    # independently, for the reason daydayup's version of this file records: two bugs in the
    # exploratory version of these same measurements were found ONLY this way -- an FFT
    # normalisation that calibrated peak amplitude while reporting RMS, and a block loop that
    # never executed on short input and read -inf for everything. Both produced numbers that
    # looked entirely plausible.
    print("\nBGM band measurement")
    t = np.arange(sr * 4) / sr

    # band_rms: a sine reads its own RMS inside its own band and essentially nothing outside it.
    for f, amp in ((100.0, 0.5), (1000.0, 0.25), (5000.0, 0.1)):
        x = (amp * np.sin(2 * np.pi * f * t))[:, None]
        got = audit.band_rms(x, sr, f * 0.8, f * 1.25)
        check(f"a {f:.0f} Hz sine reads its own RMS in its own band",
              near(got, audit.db(amp / np.sqrt(2)), 0.5), f"got {got:.2f}")
        check(f"...and nothing 4-6x above it",
              audit.band_rms(x, sr, f * 4, f * 6) < audit.db(amp / np.sqrt(2)) - 50)

    # Two independent implementations of one truth: summing band_profile's log-spaced bands
    # across 250-2000 Hz must land where band_rms puts the same range directly.
    rng = np.random.default_rng(11)
    noise = (rng.standard_normal(sr * 4) * 0.05)[:, None]
    prof = audit.band_profile(noise, sr)
    edges = audit.band_edges()
    sel = [b for b in range(audit.BAND_N) if edges[b] >= 250 and edges[b + 1] <= 2000]
    agg = audit.db(np.sqrt(np.sum(10 ** (prof[sel] / 10.0))))
    direct = audit.band_rms(noise, sr, edges[sel[0]], edges[sel[-1] + 1])
    check("band_profile and band_rms agree on broadband noise", near(agg, direct, 0.5),
          f"{agg:.2f} vs {direct:.2f}")

    # profile_diff's ENERGY WEIGHTING, which is what makes the number mean anything. Unweighted,
    # a band sitting at -100 dBFS votes as loudly as the one carrying the music, and in an empty
    # band the only thing left is FFT leakage whose phase differs between the two windows:
    # daydayup measured 6.12 dB on a bed whose head and tail were IDENTICAL BY CONSTRUCTION,
    # enough to fail a 3.5 dB gate on nothing at all.
    per = np.stack([0.3 * np.sin(2 * np.pi * 440 * t[:sr]),
                    0.3 * np.sin(2 * np.pi * 660 * t[:sr])], axis=1)
    same = np.concatenate([per] * 10)
    got_same = audit.xfade_band_diff(same, sr)
    # Phrased as `not isnan and < 0.5` rather than `not (x > 0.5)`: a signal shorter than 4x the
    # crossfade window returns nan, and `nan > 0.5` is False -- so the lazier phrasing would let
    # "too short to measure" through as a pass.
    check("a head and tail that are identical by construction read ~0 dB",
          not np.isnan(got_same) and got_same < 0.5, f"got {got_same}")
    other = np.stack([0.3 * np.sin(2 * np.pi * 3000 * t[:sr]),
                      0.3 * np.sin(2 * np.pi * 3300 * t[:sr])], axis=1)
    got_lurch = audit.xfade_band_diff(np.concatenate([per] * 9 + [other]), sr)
    check("a tail three octaves away reads as a lurch", got_lurch > 5.0, f"got {got_lurch}")
    check("a signal shorter than 4x the crossfade window reads nan, not a number",
          np.isnan(audit.xfade_band_diff(per, sr)))

    print("\nBGM production steps")

    # low_shelf, held to the DESIGN REQUIREMENT rather than to its own formula -- which is what
    # caught the order being wrong (a 2nd-order shelf reaches only -6.9 dB at f0/2, i.e. it
    # under-delivers in the exact band it is aimed at).
    def shelf_at(f, f0=80.0, g=-14.0):
        y = process_music.low_shelf((0.4 * np.sin(2 * np.pi * f * t))[:, None], sr, f0, g)
        return audit.db(float(np.sqrt(np.mean(y ** 2)))) - audit.db(0.4 / np.sqrt(2))
    at40, at80, at160, at2k = (shelf_at(f) for f in (40.0, 80.0, 160.0, 2000.0))
    check("the shelf delivers near its full cut by f0/2", -14.5 < at40 < -10.0, f"got {at40:.2f}")
    check("the shelf is unity well above f0", abs(at2k) < 0.3, f"got {at2k:.2f}")
    check("the shelf is monotonic across the corner", at40 < at80 < at160 < at2k,
          f"{at40:.1f} {at80:.1f} {at160:.1f} {at2k:.1f}")
    # Circularity is the property that lets a filter run over a LOOP region without inventing a
    # seam. Asserted by commuting the filter with a rotation, which only a circular operator does.
    sig = (rng.standard_normal(4096) * 0.1)[:, None]
    rot_then = np.roll(process_music.low_shelf(sig, sr, 80.0, -14.0), 137, axis=0)
    then_rot = process_music.low_shelf(np.roll(sig, 137, axis=0), sr, 80.0, -14.0)
    check("low_shelf is circular, so a loop does not gain a seam",
          float(np.max(np.abs(rot_then - then_rot))) < 1e-9)

    y, _ = process_music.set_band_target(noise, sr, -30.0)
    check("set_band_target lands on the target",
          near(audit.band_rms(y, sr, *audit.MID_BAND), -30.0, 0.01))
    loud = np.clip(noise * 40, -0.99, 0.99)
    g, trim = process_music.peak_guard(loud, -3.0)
    check("peak_guard brings a hot signal to the ceiling",
          trim < 0 and near(audit.db(float(np.max(np.abs(g)))), -3.0, 0.01))
    q, trim0 = process_music.peak_guard(noise, -3.0)
    check("peak_guard never lifts a signal already under the ceiling",
          trim0 == 0.0 and np.array_equal(q, noise))

    st = np.stack([0.3 * np.sin(2 * np.pi * 440 * t), 0.3 * np.sin(2 * np.pi * 660 * t)], axis=1)
    z = process_music.resample(st, sr, 24000)
    check("the stereo resample keeps both channels and the duration",
          z.shape[1] == 2 and near(len(z) / 24000, len(st) / sr, 1e-3))
    check("the stereo resample keeps the level",
          near(audit.db(float(np.sqrt(np.mean(z ** 2)))),
               audit.db(float(np.sqrt(np.mean(st ** 2)))), 0.3))

    print("\nBGM gate")

    # The two constants that have to agree, in two files, with no compiler between them: the
    # level `process_music.py` normalises TO must sit inside the window `audit.py` accepts. They
    # are the same decision written twice, and nothing else would notice them parting.
    lo_mid, hi_mid = next((lo, hi) for k, lo, hi, _ in audit.GATES["music"] if k == "mid_band_dbfs")
    check("the gate's mid-band window contains process_music's level target",
          lo_mid <= process_music.MID_TARGET_DBFS <= hi_mid,
          f"target {process_music.MID_TARGET_DBFS} outside [{lo_mid}, {hi_mid}]")

    check("a music path routes on its DIRECTORY, not its name",
          audit.class_for("../../client/src/assets/audio/music/bgm-lobby.mp3", "sfx") == "music")
    check("...and a cue next to it is unaffected",
          audit.class_for("../../client/src/assets/audio/sfx-unit-death_00.mp3", "sfx")
          == "feedback")
    check("a bed held to the combat gate would be rejected -- i.e. the routing is load-bearing",
          audit.gate({"duration_ms": 60000.0, "body_ms": 60000.0, "lead_silence_ms": 0.0,
                      "peak_dbfs": -12.0, "clipped_samples": 0, "channels": 2}, "sfx") != [])

    # Mutation test. A gate nobody has seen fail is not a gate (`checkWechatPackage.mjs`'s own
    # header, and the lesson §0.4 records re-learning the hard way on the asset gate). Each row
    # breaks exactly one clause of a passing measurement and names the word the failure must
    # contain, so a rule that is silently dropped or loosened stops being invisible.
    good = {"duration_ms": 60000.0, "xfade_band_diff": 1.2, "mid_band_dbfs": -29.0,
            "peak_dbfs": -12.0, "clipped_samples": 0, "kbps": 96.0}
    check("a well-formed bed passes the music gate", audit.gate(good, "music") == [],
          f"got {audit.gate(good, 'music')}")
    for field, bad, word in (
        ("duration_ms", 15000.0, "20-90s"),        # too short: tires the ear
        ("duration_ms", 95000.0, "20-90s"),        # too long: download budget
        ("xfade_band_diff", 3.4, "lurch"),         # head and tail tonally apart
        ("mid_band_dbfs", -24.0, "reading"),       # bed too loud: cues stop reading over it
        ("mid_band_dbfs", -34.0, "reading"),       # bed too quiet: the other side of the window
        ("peak_dbfs", -1.0, "headroom"),           # no headroom over the cue set
        ("peak_dbfs", -30.0, "headroom"),          # effectively inaudible
        ("clipped_samples", 4, "clipped"),
        ("kbps", 192.0, "mobile data"),
    ):
        m = dict(good, **{field: bad})
        fails = audit.gate(m, "music")
        check(f"the music gate catches {field}={bad}",
              any(word in f for f in fails), f"got {fails}")

    print()
    if FAILS:
        print(f"{len(FAILS)} FAILED: {', '.join(FAILS)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
