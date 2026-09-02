# audio-pipeline

Python scripts behind the shipped audio under `client/src/assets/audio/`. Ported from daydayup's
`tools/audio-pipeline/` on 2026-09-01 (AUDIO_DESIGN §7 step 6) — same discipline (measure, then
convert), a different source pool and one structural change.

Two drivers, because their inputs differ in kind rather than in degree:

  * **`process.py`** — the 18 cues. Input is a 40–300 ms library recording; output is peak-matched
    to the synth voice it replaces.
  * **`process_music.py`** — the BGM loops (added 2026-09-01, AUDIO_DESIGN §7 step 7). Input is a
    3–5 minute song mastered near 0 dBFS; a loop **region** has to be chosen whose two ends match
    across the player's crossfade window, and level is set by a **band target** rather than by
    peak, because music has no synth voice to match. See its module docstring.

    Masters live under `art/audio/sources/<provenance>/` — `first-party/` for one the project owns
    (that is where the shipped `bgm.lobby` comes from: `doodle-bed.flac`, lossless, so the tracked
    file IS the master), `suno/` for a generated one. The distinction is not filing: it decides
    what "reproducible" means, and `musicAssets.test.ts`'s `checkReproducible` branches on it —
    a generated master exists only as its prompt (which must be archived), a first-party master is
    a file (which must be in the repo).

    **⚠️ Masters arrive as WAV and are converted to FLAC before being tracked.** A 3.5-minute
    stereo WAV is 40 MB and compresses badly in git; the FLAC is 13 MB and lossless, so nothing is
    lost but the bytes. `.gitignore` excludes `art/audio/sources/**/*.wav` so a dropped-in master
    cannot be committed raw by accident.

`audit.py` measures and gates for both, and is deliberately the only place the band arithmetic
lives — the producer imports it rather than reimplementing it. daydayup let a search metric and its
acceptance metric drift apart three separate times; `profile_diff`'s docstring records what each
drift cost.

Authority for the audio **system** is [`design/game/AUDIO_DESIGN.md`](../../design/game/AUDIO_DESIGN.md);
for the **aesthetic** it is `design/product/art-direction-map-ui.md` §10. These scripts own neither.
They own the arithmetic between a downloaded recording and a file the game ships.

```
python -m venv --system-site-packages venv
./venv/Scripts/python -m pip install -r requirements.txt
```

## The scripts

- **`fetch_freesound.py`** — pulls CC0 candidates from freesound.org into
  `art/audio/sources/freesound/`, one label per hole the fixed packs leave. Needs
  `FREESOUND_TOKEN` (a freesound API key, from <https://freesound.org/apiv2/apply/>). **The token
  is a credential: keep it out of the repo, pass it in the environment.**

      FREESOUND_TOKEN=... ./venv/Scripts/python fetch_freesound.py [--dry-run] [--only eraser]

  Two things about this source that are not true of the others, both recorded in `packs.json`:
  the licence is per **sound** rather than per pack (so `filter=license:"Creative Commons 0"` is
  load-bearing and every sound's own licence URL is archived), and what a plain token can fetch
  is the **preview** render (128 kbps Vorbis), not the uploaded original — originals need a full
  OAuth2 browser round trip.

  > **The mistake to not repeat: freesound ANDs its query terms.** Writing a query the way you
  > would describe the sound — `"eraser pencil erasing rubber"` — returns **zero** results, while
  > `"eraser"` returns ten. It fails silently and reads exactly like "this sound does not exist".
  > Three of eight labels came back empty on the first run for no other reason. `q` is therefore
  > a **list** of one-or-two-word queries, merged by sound id.

- **`audit.py`** — objective audit + gate. Measures duration, body length, leading/trailing
  silence, attack, peak/RMS/crest, spectral centroid and rolloff, clipping, DC offset and L/R
  correlation, then fails each file against per-class limits. Run it on any incoming batch instead
  of trusting how a file sounds.

      ./venv/Scripts/python audit.py <file-or-dir>... [--class sfx|feedback|ui] [--json out.json]
      ./venv/Scripts/python audit.py ../../client/src/assets/audio --by-cue     # gate the shipped set
      ./venv/Scripts/python audit.py ../../art/audio/sources --no-gate          # survey a raw pool

  Two differences from daydayup's version, both forced by this project's source pool:

  - **Duration is gated on `body_ms`, not `duration_ms`.** The BigSoundBank takes run 1–12 s and
    the usable event inside them is 40–300 ms. Gating raw duration would reject the entire pool
    before the pipeline got a chance to trim it.
  - **The `sfx` lead-silence allowance is one rendered frame (16 ms), not 5 ms.** Battle cues are
    dispatched by `EventsPanel.flushAudio()`, which runs once per frame, so every cue already
    carries 0–16.7 ms of quantisation to the frame clock. A 5 ms budget inside the sample sits
    below the noise floor of the system's own timing. (`ui` is held to 8 ms — half a frame —
    because a button press is the most latency-sensitive event in the game.)

  The `loop` and `music` classes were **not** ported: there is no BGM yet (§7 step 7). They come
  across with it. An unused gate class is a rule nobody can be failing.

- **`process.py`** — the conversion: mono → trim → cap (faded) → peak-match → smallest
  bandwidth-legal MP3. Writes `client/src/assets/audio/` and `art/audio/credits.json`.

      ./venv/Scripts/python process.py [--dry-run]

  **The structural change from daydayup: where the peak target comes from.** daydayup read a
  `synth.json` produced by auditing re-rendered synth cues. funny cannot — its synth voices are
  live WebAudio graphs with no offline render, and §7 step 6 was already corrected once for
  assuming a voice's `gain` argument equals its delivered peak (it does not: a low-pass eats
  energy, and non-overlapping notes never sum). So the reference is the **measured delivered
  peak** from real-browser probing, recorded in AUDIO_DESIGN §0/§0.2/§0.3, and

      file_peak = delivered_peak / (catalogue_gain × bus_gain)

  with all three numbers stated per cue in `TARGETS` so the division is auditable. It is checkable
  in closed form on one cue: `sfx.ink.tick`'s voice is a single unfiltered `tone(gain: 0.07)`, and
  0.07 × 0.5 × 0.8 = 0.0280, which is exactly what the browser measured.

  It also adds **two gates on the SOURCE**, both catching defects that are invisible in the
  output:

  | rejected | why the output gate cannot see it |
  |---|---|
  | `clipped_samples > 0` | Scaling a clipped file down ~15 dB leaves the distortion baked in and makes `audit.py` read a clean 0. Not hypothetical: `book_275160.ogg` carries 1207 clipped samples at 0.18 dBFS and was a near-pick for `sfx.base.hit`. |
  | `attack_ms > cap_ms` | A rustle is a continuous gesture with no onset; the pool is full of files whose peak arrives 240 ms in. Capping such a file at 120 ms cuts it *before* its own peak, and peak-matching then amplifies the quiet run-up by whatever it takes. Reads as "the sample is broken" and has no other symptom. |

  > **The bug this file shipped once, fixed and pinned.** The head de-click fade was 4 ms
  > (daydayup's value) while the retained pre-roll is 1 ms — so 3 ms of ramp landed on **audible
  > signal** and suppressed the cue's own onset. Three of 22 assets failed the lead-silence gate
  > on latency the pipeline had invented. The fade now spans exactly `PRE_ROLL_S`. MP3 contributes
  > nothing here: libsndfile strips encoder padding, measured at 0.00 ms lead on a full-scale
  > onset at all six ladder rates.

- **`write_packs.py`** — regenerates `art/audio/packs.json` (upstream provenance per source pack).
  Separate from `credits.json` because these facts are per **source** and have a different
  lifetime: a pack's URL and licence do not change when we re-pick which of its files we ship.

      ./venv/Scripts/python write_packs.py

- **`selftest.py`** — **106** checks over the measurement, gating and conversion layer (73 before
  the BGM band/shelf/gate block landed on 2026-09-01). Plain asserts. **Runs in CI** since
  2026-09-02 (`tools-test` job in `.github/workflows/ci.yml`) — before that nothing ran it, so
  2100 lines of pipeline had a self-test that could only rot.
  Measurement is checked against **synthetic** signals with known ground truth (a 1 kHz sine must
  read a 1 kHz centroid; 50 ms of leading zeros must read 50 ms of lead), because a measurement
  checked against a real file only tells you the number did not change.

      ./venv/Scripts/python selftest.py       # from anywhere: it chdirs to the repo root itself

  It used to be **106 checks only if you ran it from the repo root**, and the docs said to run it
  from this directory. From here it crashed in the source-rejection block with a `LibsndfileError`
  (`process.SRC` is a repo-root-relative string), and before getting that far it reported the
  `credits.json` cases as "skip -- run process.py first" when the real cause was the working
  directory. Fixed 2026-09-02 by chdir-ing inside `selftest.py`, which is also what made it
  wireable into CI: the count is now the same from anywhere, and there is no wrong way to call it.

  One of its own cases was wrong on first run and is commented where it was fixed: the
  "slow attack" signal used a quiet lead followed by a bang, which does **not** reproduce the
  defect — `attack_ms` counts from the first sample above −40 dBFS-relative, so a lead sitting
  54 dB down is not part of the attack at all. What the gate is for is a continuous **swell**.

  Its `encode_smallest` block is worth keeping honest: it re-encodes at every ladder rate itself
  and asserts the search picked the actual minimum, rather than merely a legal rate. A search that
  silently degraded to "take the first" would still produce files that play and pass every other
  check — it would just cost bytes. The block also asserts the shipped set spans more than one
  sample rate, because if it ever did not, this whole search would be dead weight.

  A handful of cases need `credits.json` on disk (the tables-vs-record comparisons). Those
  **skip, loudly**, when it is absent — before the first `process.py` run "the record disagrees"
  and "there is no record" are different findings and only the first is a defect.

## What runs in CI, and what does not

**None of these.** That would put a Python toolchain in every build. They run once per batch of
material. Everything they establish is therefore re-checked by
`client/test/audio/audioAssets.test.ts`, which needs no decoder and no Python: it parses the MP3s
at the frame level and holds the files on disk, `credits.json`, `packs.json`, the `AudioCue` union
and the live `CUE_CATALOGUE` to each other.

The check in there worth knowing about is **`catalogue_gain` still matching `cueCatalogue.ts`**.
Every shipped sample was scaled so that swapping a synth voice for a sample does not change that
cue's weight in the mix. Edit a gain in `cueCatalogue.ts` and the arithmetic behind 22 files
quietly stops holding — the files still load, still play, still pass everything else, and the only
symptom is a mix that drifted away from the design.

That file is structured as ten pure rules plus a **mutation suite** that breaks each contract in
turn and asserts the matching rule complains — the same standard `scripts/checkWechatPackage.mjs`
states with its `--pkg` flag: *a gate nobody has seen fail is not a gate.* Writing that suite is
what found the two holes its first version could not see, and both are now rules of their own:

- **`variantMapping`** — the original cases checked that a cue had the right *number* of variants
  and that the files existed, never that a cue pointed at *its own* recordings. Swap two cues'
  import arrays in `cueAssets.ts` and every one of them stayed green while the game played the
  wrong sound for both. (The mutation case asserts exactly that: the old rules are all still happy
  on the swapped snapshot.)
- **`sourceUniqueness`** — one recording shipped as two different cues. Nearly happened here:
  `stroke_632474.ogg` was a strong candidate for both `sfx.card.play` and `sfx.unit.attack`.

A third measurement surface sits in the browser: `window.__nwAudio.samples()` in
`entries/web-e2e.ts` reports the peak of every **decoded** buffer, which is the one thing this
pipeline structurally cannot check about its own output — it peak-matches *before* a lossy encode.
Measured 2026-09-01: the MP3 round trip moves the peak by −6.1% to +6.7% (≈ ±0.56 dB), about a
quarter of the smallest deliberate step in the catalogue (0.7 ↔ 0.9, ≈ 2.2 dB).

## Toolchain note

These are **Python**, unlike the rest of `tools/` which is Node. The reason is
`soundfile`/`libsndfile`, which decodes and encodes OGG/MP3/WAV/FLAC in one dependency; there is
no comparable single Node dependency, and this machine has no `ffmpeg`. `venv/` is gitignored —
recreate it with the two commands at the top.

## The BGM gate, and the one class deliberately left behind

`audit.py` has a `music` gate class (20–90 s, `xfade_band_diff <= 2.5 dB`, `mid_band_dbfs` inside
[−30, −28], no clipping, ≤ 128 kbps) and routes a file to it by **directory** — `assets/audio/music/`
— rather than by name, because a track has no cue prefix and would otherwise fall through to the
combat gate and be rejected for being long and stereo.

It does **not** have daydayup's `loop` class, and that is a decision rather than an omission. That
gate requires `step_db <= -50`: the last sample of the file sitting next to the first, which is what
`el.loop = true` needs. MP3 pads both ends to a frame boundary, so sample-exact wrapping is
unavailable no matter how the region is cut — `MusicPlayer` crossfades a second deck over the tail
instead. Porting `loop` would be a gate held against a mechanism this client does not have.

**Where the −29 dBFS level target comes from** is written out in `audit.py`'s `music` gate comment,
and `process_music.py --track` reprints the derivation from `process.py`'s measured `TARGETS` after
every run. It is not copied from daydayup's −30: this repo's cues are quieter on file and carry
their own catalogue gains, so the number had to be re-derived. The binding constraint is
`sfx.unit.attack` standing +10.3 dB above the bed.
