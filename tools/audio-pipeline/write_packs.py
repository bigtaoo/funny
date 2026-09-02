"""Write art/audio/packs.json: upstream provenance for every source pack.

Separate from `credits.json` (which is per shipped FILE) because these facts are per SOURCE and
have a different lifetime -- a pack's download URL and licence do not change when we re-pick
which of its files we ship. Regenerated rather than hand-maintained so the `files_used` lists
cannot drift from what `process.py` actually read, and so the freesound rows (whose licence is
per sound, not per pack) are copied from the fetch record instead of retyped.

Usage: ./venv/Scripts/python write_packs.py
"""
import hashlib, json, os, sys

CREDITS = "art/audio/credits.json"
FETCHED = "art/audio/sources/freesound/fetched.json"
OUT = "art/audio/packs.json"
ZIP = "art/audio/sources/kenney_interface-sounds.zip"

PACKS = {
    "kenney-interface-sounds": {
        "title": "Interface Sounds (1.0)",
        "author": "Kenney",
        "page": "https://kenney.nl/assets/interface-sounds",
        "download": "https://kenney.nl/media/pages/assets/interface-sounds/"
                    "fa43c1dd4d-1677589452/kenney_interface-sounds.zip",
        "license": "CC0-1.0",
        "license_text": "art/audio/licenses/kenney-interface-sounds-LICENSE.txt",
        "attribution_required": False,
        "zip_bytes": 834536,
        "sha256": "f2193d072726d6758a5f7871b2dcc54dcce0d5c35c6f0a62f92549b327c81232",
        "note": "The ONLY Kenney audio pack this project can use. Its siblings (Impact / Sci-Fi / "
                "Digital) are metal impacts, glass, lasers and explosions -- art-direction §10's "
                "forbidden list, near-verbatim. Only the two files that ship are archived; "
                "`fetch_packs.py --only kenney` re-downloads the 100-file pack and CHECKS the "
                "sha256 above, which is a stronger guarantee than a committed blob -- a blob can "
                "only be trusted, a hash can be verified.",
    },
    "bigsoundbank": {
        "title": "BigSoundBank (LaSonotheque)",
        "author": "Joseph SARDIN",
        "page": "https://bigsoundbank.com/",
        "download": "per sound: https://bigsoundbank.com/UPLOAD/mp3/<id>.mp3 "
                    "(the id is the -sNNNN suffix in each archived filename)",
        "license": "CC0-1.0",
        "license_text": None,
        "attribution_required": False,
        "note": "Each sound's own page states 'License CC0 (public domain): Free and royalty-free', "
                "answers 'Do I have to credit?' with 'No', and needs no account. MP3 is the only "
                "format served anonymously (wav/flac are behind a login), so these sources are "
                "lossy -- same situation as the .ogg packs, and the shipped asset is MP3 anyway. "
                "No licence text file is archived because the licence is stated on the web page "
                "rather than shipped in a bundle; recorded as a gap rather than papered over.",
    },
    "oga-luckius-paper": {
        "title": "Various Paper Sound Effects",
        "author": "Luckius",
        "page": "https://opengameart.org/content/various-paper-sound-effects",
        "download": "https://opengameart.org/sites/default/files/<name>.mp3",
        "license": "CC0-1.0",
        "license_text": None,
        "attribution_required": False,
        "note": "Seven files: 2 crushed, 1 ripped, 4 handling. Submitted as CC0; the author asks "
                "for credit as a courtesy, which credits.json gives.",
    },
    "freesound": {
        "title": "freesound.org (per-sound CC0 selection)",
        "author": "various -- see sounds[] below",
        "page": "https://freesound.org/",
        "download": "preview-hq-ogg via the freesound API v2 (search/text + a token)",
        "license": "CC0-1.0 (asserted per sound, not per pack -- see sounds[])",
        "license_text": None,
        "attribution_required": False,
        "note": "The only QUERYABLE source in the pool, and the reason `sfx.card.invalid` exists "
                "at all: neither Kenney nor BigSoundBank has an eraser. Fetched by "
                "tools/audio-pipeline/fetch_freesound.py with filter=license:\"Creative Commons "
                "0\", and every sound's own licence URL is recorded below. **These are PREVIEW "
                "renders (128 kbps Vorbis), not the uploaded originals** -- a plain API token "
                "authorises previews, while originals need a full OAuth2 browser round trip. For "
                "40-400 ms foley that is re-encoded to MP3 regardless, the second lossy stage "
                "was judged not worth the OAuth flow; if a cue ever sounds gritty, this is the "
                "first thing to re-check.",
    },
}


def main() -> int:
    for p in (CREDITS, FETCHED):
        if not os.path.exists(p):
            print(f"missing {p} -- run process.py / fetch_freesound.py first", file=sys.stderr)
            return 1

    credits = json.load(open(CREDITS))
    used: dict[str, set[str]] = {}
    for cue in credits["cues"]:
        for f in cue["files"]:
            pack, rel = f["source"].split("/", 1)
            used.setdefault(pack, set()).add(rel)

    fetched = {r["file"]: r for r in json.load(open(FETCHED))}

    packs = []
    for pid, meta in PACKS.items():
        entry = {"id": pid, **meta, "files_used": sorted(used.get(pid, ()))}
        # The zip is not committed (see the pack note), but when it IS on disk its bytes must
        # agree with the record — otherwise the record is describing a pack nobody has.
        if pid == "kenney-interface-sounds" and os.path.exists(ZIP):
            got = hashlib.sha256(open(ZIP, "rb").read()).hexdigest()
            if got != meta["sha256"]:
                print(f"WARNING: {ZIP} sha256 {got} != recorded {meta['sha256']}", file=sys.stderr)
        if pid == "freesound":
            entry["sounds"] = [
                {k: fetched[f][k] for k in
                 ("file", "freesound_id", "title", "author", "license", "preview")}
                for f in sorted(used.get(pid, ())) if f in fetched
            ]
            missing = sorted(f for f in used.get(pid, ()) if f not in fetched)
            if missing:
                print(f"WARNING: no fetch record for {missing}", file=sys.stderr)
        packs.append(entry)

    json.dump({
        "note": "Upstream provenance for the audio sources under art/audio/sources/. Per-file "
                "picks and rationale are in credits.json. Written by "
                "tools/audio-pipeline/write_packs.py -- edit that, not this.",
        "all_sources_commercial_ok_without_attribution": True,
        "packs": packs,
    }, open(OUT, "w"), indent=1)
    total = sum(len(p["files_used"]) for p in packs)
    print(f"{len(packs)} packs, {total} source files used -> {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
