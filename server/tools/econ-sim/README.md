# econ-sim — SLG persistent-economy aggregation simulator

Economy-side counterpart of `client/test/difficultySim.ts`. Headless, imports
`@nw/shared` constants (`SETTLE_REWARDS` / `CENTER_CAPITAL_MULT` / `WORLD_CAPACITY` /
`DUPE_REFUND_COINS` / `GACHA_MATERIAL_GRANTS`), **never connects to the DB**.

Implements the **A-track** of [`design/game/SLG_ECONOMY_CHECK.md`](../../../design/game/SLG_ECONOMY_CHECK.md):
aggregate one SLG season server-wide and check the §2.3 judgments. Numbers are
registered in [`ECONOMY_NUMBERS.md` §13-SLG](../../../design/game/ECONOMY_NUMBERS.md).

## Run

```bash
cd server/tools/econ-sim
npx tsx src/index.ts                     # conservative + baseline + aggressive
npx tsx src/index.ts scenarios/foo.json  # one scenario file
npx tsc --noEmit                         # typecheck
```

## What it computes

- **Material → coin valuation** (`src/valuation.ts`): conservative upper bound derived
  from `DUPE_REFUND_COINS / GACHA_MATERIAL_GRANTS` (scrap=1, lead=16.67, binding=400).
- **Per-head aggregation** (`src/model.ts`): settle rewards go to every member of a
  ranked sect (per-head, the pinned granularity), so `participant` head count dominates.
- **§2.3 judgments**: 人均稀释 (per-head) · 全服通胀 (vs material grind faucet — correct
  units; vs coin faucet flagged as informational cross-ref since settle injects 0 coins) ·
  coin 子项 (must be 0) · 头部倾斜 (champion/participant per-head).

## Scenarios (`scenarios/*.json`)

`population × membersPerSect distribution × capitalHoldRate` are the levers (per-head
granularity is fixed). Edit/add JSON files; the schema is `Scenario` in `src/model.ts`.

> Levers that dominate the verdict: the **binding valuation** (400) and the
> **participant head count**. Nail those two before trusting any conclusion (§2.4).
