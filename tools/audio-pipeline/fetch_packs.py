"""Fetch the three FIXED source packs into art/audio/sources/.

The counterpart to `fetch_freesound.py`, which handles the one source that has to be *queried*.
These three are inventories you read by hand, so what is scripted is only the download — the
selection is the `SLUGS` / `FILES` lists below, which are the candidate pool the pick was made
from, not just the files that shipped.

Why the pool is scripted rather than committed whole: BigSoundBank's takes are 320 kbps MP3s
running 1-39 seconds, and the 42 candidates weighed 21 MB against the 2 that shipped. Only the
files `process.py` actually reads are archived under `art/audio/sources/`; re-running this brings
the rest back for a re-pick. (`freesound/` IS committed whole — 1.4 MB for 80 files, and it is the
bench you reach for when a pick turns out to sound wrong.)

Usage:
    ./venv/Scripts/python fetch_packs.py [--only bigsoundbank|kenney|opengameart]
"""
import argparse, hashlib, os, sys, urllib.request, zipfile

UA = "notebook-wars-audio"
SRC = "art/audio/sources"

# BigSoundBank: CC0, no account, MP3 is the only anonymously served format. The `-sNNNN` suffix IS
# the sound id, so the download URL is derivable from the filename and provenance stays readable
# off `art/audio/sources/bigsoundbank/` alone.
BSB_SLUGS = """
pencil-s0221 pencil-2-s3233 pencil-3-s3234 pencil-4-s3235
pencil-signature-1-s3236 pencil-signature-2-s3237 pencil-signature-3-s3238
sharpener-s0051 felt-coloring-s1426
turned-page-s0164 pages-that-turn-s0493 pages-that-turn-2-s1413
pages-that-turn-3-s2210 pages-that-turn-4-s2211 pages-that-turn-5-s2212
pages-that-turn-6-s2213 pages-that-turn-7-s2214 pages-that-turn-8-s2215
pages-that-turn-9-s2216 great-page-that-turns-1-s0362 great-page-that-turns-1-s0363
ball-paper-3-s1222 ball-paper-4-s1223 newspaper-ball-s0670
paper-s0785 news-paper-pages-s1250 news-paper-manipulations-s1251 newspaper-page-s0669
torn-paper-s0018 torn-paper-2-s3239 torn-paper-4-s3241 torn-paper-7-s3244
newspaper-is-torn-s0671 torn-and-creased-page-1-s1225 torn-and-creased-page-2-s1226
closed-book-1-s1410 closed-book-2-s1411 closed-book-3-s1412
drops-of-water-1-s1384 drops-of-water-2-s1385 drops-of-water-3-s1386 drops-of-water-4-s1387
""".split()

# OpenGameArt, Luckius, CC0. Seven files, all of them small enough to keep.
OGA_FILES = ["paper_crushed_-_1", "paper_crushed_-_2", "paper_ripped_-_1",
             "paper_sound_-_1", "paper_sound_-_2", "paper_sound_-_3", "paper_sound_-_4"]

# The one Kenney audio pack art-direction §10 does not rule out; its Impact / Sci-Fi / Digital
# siblings are metal, glass, lasers and explosions, i.e. the forbidden list near-verbatim.
KENNEY_URL = ("https://kenney.nl/media/pages/assets/interface-sounds/"
              "fa43c1dd4d-1677589452/kenney_interface-sounds.zip")
KENNEY_SHA256 = "f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232"


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def fetch_bigsoundbank() -> int:
    dst = os.path.join(SRC, "bigsoundbank")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for slug in BSB_SLUGS:
        out = os.path.join(dst, slug + ".mp3")
        if os.path.exists(out) and os.path.getsize(out) > 1000:
            continue
        sound_id = slug.rsplit("-s", 1)[1]
        try:
            data = get(f"https://bigsoundbank.com/UPLOAD/mp3/{sound_id}.mp3")
        except Exception as e:                                   # noqa: BLE001 - report, continue
            print(f"FAIL {slug}: {e}", file=sys.stderr)
            continue
        if len(data) < 1000:
            print(f"FAIL {slug}: {len(data)} bytes", file=sys.stderr)
            continue
        open(out, "wb").write(data)
        n += 1
    print(f"bigsoundbank: {n} new, {len(os.listdir(dst))} on disk")
    return n


def fetch_opengameart() -> int:
    dst = os.path.join(SRC, "oga-luckius-paper")
    os.makedirs(dst, exist_ok=True)
    n = 0
    for name in OGA_FILES:
        out = os.path.join(dst, name + ".mp3")
        if os.path.exists(out):
            continue
        open(out, "wb").write(get(f"https://opengameart.org/sites/default/files/{name}.mp3"))
        n += 1
    print(f"oga-luckius-paper: {n} new, {len(os.listdir(dst))} on disk")
    return n


def fetch_kenney() -> int:
    zip_path = os.path.join(SRC, "kenney_interface-sounds.zip")
    dst = os.path.join(SRC, "kenney-interface-sounds")
    if not os.path.exists(zip_path):
        open(zip_path, "wb").write(get(KENNEY_URL))
    got = hashlib.sha256(open(zip_path, "rb").read()).hexdigest()
    if got != KENNEY_SHA256:
        # Not a warning: a pack whose bytes changed is a different pack, and every pick in
        # credits.json was made against the recorded one.
        print(f"FAIL kenney sha256 mismatch\n  want {KENNEY_SHA256}\n  got  {got}", file=sys.stderr)
        return -1
    os.makedirs(dst, exist_ok=True)
    with zipfile.ZipFile(zip_path) as z:
        z.extractall(dst)
    lic = os.path.join(dst, "License.txt")
    if os.path.exists(lic):
        target = "art/audio/licenses/kenney-interface-sounds-LICENSE.txt"
        os.makedirs(os.path.dirname(target), exist_ok=True)
        open(target, "wb").write(open(lic, "rb").read())
    print(f"kenney-interface-sounds: sha256 verified, extracted to {dst}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", action="append",
                    choices=["bigsoundbank", "kenney", "opengameart"])
    args = ap.parse_args()
    which = args.only or ["kenney", "bigsoundbank", "opengameart"]
    rc = 0
    for w in which:
        if w == "kenney" and fetch_kenney() < 0:
            rc = 1
        elif w == "bigsoundbank":
            fetch_bigsoundbank()
        elif w == "opengameart":
            fetch_opengameart()
    return rc


if __name__ == "__main__":
    sys.exit(main())
