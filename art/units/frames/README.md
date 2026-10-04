# Frame-sheet units (pilot: Lena, Mara)

Specs for `tools/unit-frames/bake.py`, one folder per unit. Each `<unit>.json` warps the unit's
existing full-body drawing (`art/units/<unit>/<unit>.png`) into its battle clips and writes
`client/src/assets/units/frames/<unit>.png` + `.json`. Design: `design/product/art-direction.md` §4.3.1.

Re-bake after editing a spec:

    python tools/unit-frames/bake.py art/units/frames/lena/lena.json --preview <scratch>/lena.png

The `.txt` files are the prompts tried for extra key drawings (stride, aim):

- The image-edit prompts (`*_stride.txt`, `mara_aim.txt`) were all refused by Mistral's moderation
  ("Protected Content") when given the Anna-side reference art.
- `mara_aim_t2i.txt` went through as text-to-image, but its result (`mara_aim_t2i_v1.png`) faces left
  and leaves the watercolour style, so it is kept only as a record and is not used.
