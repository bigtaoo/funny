# unit-frames — battle units as baked frame sequences

Battle units are 46–81 design px tall (`client/src/render/unitSize.ts`). At that size a bone rig
shows its seams but none of its joints; what reads is the silhouette and its whole-body motion.
So a unit can instead be one complete drawing per clip, warped offline into frames
(`bake.py`) and played back by `client/src/render/frames/FrameRuntime.ts`.
Design: `design/product/art-direction.md` §4.3. Ported from `D:\standing\tools\bake_mob.py`.

| File | What |
|---|---|
| `bake.py <spec.json> [--preview <out.png>] [--debug <clip> <out.png>]` | Bake a unit's clips into `client/src/assets/units/frames/<unit>.png` + `.json`. `--preview` also writes a strip and a GIF at 2× game size; `--debug` draws a clip's deformer regions over its source. |
| `split_parts.py <parts_spec.json> <out dir>` | Split a rig-ready drawing into parts (joint `discs`, `hidden` fills with optional `clone`, `open`, `flip`, `outline`); writes the parts, `parts.json` and an exploded `preview.png`. Format at the top of the file. |
| `rig.py` | Cutout rig used by `bake.py` for `"source": "rig"` clips: forward kinematics, spline/eased keys, sole planting, rig-drawn `lines` (bowstring, nocked arrow) with per-clip overrides. Format at the top of the file. |
| `cutout.py` | Cuts a drawing out of its white background (used by `bake.py` for sources without alpha). |
| `generate_image.sh <out> <prompt file>` | Mistral text-to-image. |
| `edit_image.sh <in> <out> <prompt file>` | Mistral image edit from a reference. |
| `mistral_failover.sh` | Key rotation for the two scripts above; keys live in `~/.vibe/mistral_curl_key{A,B,C}.conf`, never in the repo. |

Specs and prompts live in `art/units/frames/<unit>/`. The spec format is documented at the top of
`bake.py`; tune regions with `--debug`, then judge motion with `?unitlab` on the dev server, which
plays every frame-sheet unit next to its bone rig.

Two ways to make frames:

- **Warp** one whole drawing per clip (the first pilot). No seams, but limbs barely move.
- **Rig** (current for Lena and Mara): a rig-ready drawing (limbs apart, joints visible, facing
  right; made in ChatGPT) is split into parts, posed with forward kinematics and baked to the same
  sheets. Cut both limbs at each joint and give each a disc there; put the hip pivot at the real
  hip, not the skirt hem; mirror (`flip`) a part drawn facing the wrong way; check every part
  alone over a flat colour for detached fills.

Known limits:

- One drawing per clip bends, sways and swings; it cannot turn a limb more than ~30° or show
  what the drawing hides. A large pose change (a full bow draw, an overhead swing) needs its own
  key drawing as a second source.
- Mistral's moderation refuses edits of the Anna-side reference art ("Protected Content"), so
  new key drawings for those characters have to come from text-to-image or another tool, and
  text-to-image drifts off the watercolour style (`art/units/frames/mara/mara_aim_t2i_v1.png`).
