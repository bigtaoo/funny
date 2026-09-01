"""Fetch CC0 stationery foley from freesound.org into art/audio/sources/freesound/.

Why this exists as a script and not a list of URLs: freesound is the only source in the pool
that can be QUERIED -- BigSoundBank and Kenney are fixed inventories you read by hand, while
freesound has 261 CC0 paper-crumples alone, and the useful ones are selected by duration, not
by name. The per-cue queries below encode which search actually returns short takes.

Two things about this source that are NOT true of the others:

  * **Previews, not originals.** A plain API token authorises search plus the four preview
    renders; downloading the uploaded file needs a full OAuth2 round trip through a browser.
    We take `preview-hq-ogg` (Vorbis) rather than `preview-hq-mp3`, because the shipped asset
    is itself MP3 and Vorbis->MP3 beats MP3->MP3 on the same nominal bitrate. daydayup's
    entire source pool was .ogg for the same reason, so this is not a new compromise.
  * **The licence is per SOUND, not per pack.** Kenney and BigSoundBank declare one licence
    for everything; on freesound each upload carries its own, so `filter=license:"Creative
    Commons 0"` is load-bearing and the licence URL of every fetched sound is recorded in
    `fetched.json` next to it.

Usage:
    FREESOUND_TOKEN=... ./venv/Scripts/python fetch_freesound.py [--dry-run] [--only eraser]
"""
import argparse, json, os, sys, urllib.parse, urllib.request

API = "https://freesound.org/apiv2/search/text/"
CC0 = 'license:"Creative Commons 0"'
DST = "art/audio/sources/freesound"

# One entry per hole the free packs leave, keyed by a short label that becomes the filename
# prefix. `dur` is the range that makes the search useful rather than exhaustive: a 48-second
# "PaperCrumpling 1" take is the top CC0 result for `paper crumple` and is useless as a cue.
#
# `need` is how many to keep. It is deliberately larger than the variant count a cue will
# ship: the pipeline picks on measured attack/centroid afterwards, and picking from three
# candidates is picking from whatever three arrived first.
#
# **`q` is a LIST of one-or-two-word queries, deliberately, not one descriptive phrase.**
# freesound's text search ANDs its terms across name+tags+description, so the natural way to
# write these -- `"eraser pencil erasing rubber"` -- returns exactly **zero** results while
# `"eraser"` returns ten. That failure is silent and looks like "this sound does not exist on
# freesound": three of the seven labels here came back empty on the first run for no other
# reason. Each term is issued as its own request and the results are merged by sound id.
QUERIES = {
    # THE gap in the free packs: no eraser anywhere in BigSoundBank or Kenney, and
    # `sfx.card.invalid` is the one cue whose whole job is to sound like erasing a mistake.
    # Also the shallowest pool in this table (~10 CC0 hits under 2 s), so it takes what exists.
    "eraser":      dict(q=["eraser", "erasing", "erase"], dur=(0.1, 2.0), need=8),
    # Short crumples. BigSoundBank's ball-paper takes run 1-3 s of continuous scrunching;
    # a death cue needs the single crush.
    "crumple":     dict(q=["crumple", "crumpling", "crush paper"], dur=(0.15, 1.2), need=8),
    # Pencil on paper, short strokes -- `sfx.card.play` (a stroke) and `sfx.unit.attack`
    # (a jab). BigSoundBank's Pencil #1 is a 20 s continuous writing take.
    "pencil":      dict(q=["pencil", "scribble"], dur=(0.08, 1.5), need=10),
    # A second pencil label, and the one case where a MULTI-word query is the right tool:
    # "pencil writing" ANDs down to a single uploader's set of "Pencil writing on paper
    # (N strokes)" takes -- 1, 3, 4, 7, 8 strokes as separate files, which is the cleanest
    # `sfx.card.play` / `sfx.unit.attack` material in the whole pool. Sorting the broad
    # `pencil` query by downloads buries them under generic scribbles, so they get their own
    # label rather than a bigger `need`.
    "stroke":      dict(q=["pencil writing"], dur=(0.08, 1.5), need=14),
    # `sfx.ink.tick`: a single drop, not a dripping-tap ambience.
    "drop":        dict(q=["droplet", "water drop"], dur=(0.05, 1.0), need=6),
    # `sfx.base.hit`: a thick book landing/closing. BigSoundBank has three; more candidates
    # means the pick can be made on centroid instead of on availability.
    "book":        dict(q=["book", "thud"], dur=(0.1, 1.5), need=8),
    # `sfx.spell.cast`: a page turn with some body to it.
    "page":        dict(q=["page turn", "pageturn"], dur=(0.1, 1.5), need=6),
    # `sfx.unit.hit`: a soft paper hit/rustle, the "puff" in the design table.
    "rustle":      dict(q=["rustle", "paper hit"], dur=(0.05, 1.0), need=8),
    # A second `sfx.unit.hit` label with a much TIGHTER duration window, added after the first
    # audit pass found the real hole in the pool: every paper rustle it returned has a 200-400 ms
    # attack, because a rustle is a continuous gesture with no onset. `unit.hit` fires ~50 times
    # a match and is capped at 120 ms, so a 240 ms attack means the cap cuts the file BEFORE its
    # own peak -- and then peak-matching amplifies whatever is left. Capping the search at 0.4 s
    # is what makes the search return single impacts instead.
    "hit":         dict(q=["cardboard", "paper", "thump"], dur=(0.05, 0.4), need=12),
}


def search(token: str, spec: dict) -> list[dict]:
    """Union of one request per query term, deduped by sound id, best-downloaded first."""
    lo, hi = spec["dur"]
    merged: dict[int, dict] = {}
    for term in spec["q"]:
        qs = urllib.parse.urlencode({
            "query": term,
            "filter": f'{CC0} duration:[{lo} TO {hi}]',
            "fields": "id,name,username,duration,license,previews,num_downloads",
            "sort": "downloads_desc",
            "page_size": max(spec["need"] * 3, 15),
        })
        req = urllib.request.Request(f"{API}?{qs}", headers={"Authorization": f"Token {token}"})
        with urllib.request.urlopen(req, timeout=30) as r:
            for h in json.load(r)["results"]:
                merged.setdefault(h["id"], h)
    return sorted(merged.values(), key=lambda h: -(h.get("num_downloads") or 0))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="list what would be fetched")
    ap.add_argument("--only", action="append", choices=list(QUERIES),
                    help="restrict to these labels (repeatable)")
    args = ap.parse_args()

    token = os.environ.get("FREESOUND_TOKEN")
    if not token:
        print("FREESOUND_TOKEN is not set", file=sys.stderr)
        return 2

    os.makedirs(DST, exist_ok=True)
    labels = args.only or list(QUERIES)
    record = []
    for label in labels:
        spec = QUERIES[label]
        try:
            hits = search(token, spec)
        except Exception as e:                                   # noqa: BLE001 - report, continue
            print(f"ERROR {label}: {e}", file=sys.stderr)
            continue
        kept = 0
        for h in hits:
            if kept >= spec["need"]:
                break
            url = (h.get("previews") or {}).get("preview-hq-ogg")
            if not url:
                continue
            name = f"{label}_{h['id']}.ogg"
            path = os.path.join(DST, name)
            print("%-9s %-40s %6.2fs %7d dl  %s" % (
                label, h["name"][:40], h["duration"], h.get("num_downloads") or 0, name))
            if not args.dry_run and not os.path.exists(path):
                req = urllib.request.Request(url, headers={"User-Agent": "notebook-wars-audio"})
                with urllib.request.urlopen(req, timeout=60) as r, open(path, "wb") as f:
                    f.write(r.read())
            record.append({
                "file": name, "freesound_id": h["id"], "title": h["name"],
                "author": h.get("username"), "license": h["license"],
                "source_duration_s": round(h["duration"], 3),
                "preview": "preview-hq-ogg",
            })
            kept += 1
        if kept < spec["need"]:
            print(f"  note: {label} kept {kept}/{spec['need']} -- query returned fewer usable hits")

    if not args.dry_run:
        # Merged, not overwritten: --only must not erase the provenance of earlier labels.
        rec_path = os.path.join(DST, "fetched.json")
        old = json.load(open(rec_path)) if os.path.exists(rec_path) else []
        by_file = {r["file"]: r for r in old}
        by_file.update({r["file"]: r for r in record})
        json.dump(sorted(by_file.values(), key=lambda r: r["file"]),
                  open(rec_path, "w"), indent=1)
        print(f"\n{len(record)} fetched, {len(by_file)} recorded in {rec_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
