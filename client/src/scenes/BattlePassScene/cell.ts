import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { snapFont, fitFont } from '../../render/fontScale';
import { buildRewardIcon } from '../../render/rewardIcon';

// ── Pure reward-cell drawing helpers for BattlePassScene ──────────────────────
//
// Extracted from the scene class (form① partial split, client-modules.md §split
// convention): fully parameterized, zero `this.` — render()'s per-level loop
// stays on the class, only the per-cell drawing/state math moved out.

/** Four cell states for a single reward cell */
export type CellState = 'claimable' | 'claimed' | 'locked' | 'pass_required';

export function cellState(
  track: 'free' | 'paid',
  level: number,
  currentLevel: number,
  claimedFree: Set<number>,
  claimedPaid: Set<number>,
  hasPass: boolean,
  hasReward: boolean,
): CellState {
  if (!hasReward) return 'locked';
  const claimed = track === 'free' ? claimedFree.has(level) : claimedPaid.has(level);
  if (claimed) return 'claimed';
  if (level > currentLevel) return 'locked';
  if (track === 'paid' && !hasPass) return 'pass_required';
  return 'claimable';
}

/**
 * Encircles the current level's row (both free + paid cells) in an accent frame so it reads as
 * "you are here" independent of claim state — a claimed current-level row previously looked
 * identical to any other claimed row.
 */
export function drawCurrentLevelFrame(parent: PIXI.Container, freeX: number, paidX: number, halfW: number, cellY: number, cellH: number): void {
  const pad = 3;
  const x = freeX - pad;
  const y = cellY - pad;
  const w = (paidX + halfW - freeX) + pad * 2;
  const h = cellH + pad * 2;
  const frame = new PIXI.Graphics();
  frame.lineStyle(3, C.accent, 1).drawRoundedRect(x, y, w, h, 10);
  parent.addChild(frame);
}

export function drawCell(
  parent: PIXI.Container,
  x: number, y: number, w: number, h: number,
  level: number,
  reward: { kind: string; id?: string; count: number } | null,
  state: CellState,
): void {
  // Milestone rows (every 5th level) carry the coin jackpots — tint them gold so they stand out
  // from the material-filler rows, unless an active state (claimable/claimed) owns the colour.
  const milestone = level % 5 === 0;
  const fillColor = state === 'claimable' ? 0xe8f5e9
    : state === 'claimed' ? 0xf0f0f0
      : milestone ? 0xfdf3d0
        : C.paper;
  const borderColor = state === 'claimable' ? C.green
    : state === 'claimed' ? C.line
      : (state === 'pass_required' || milestone) ? C.gold
        : C.line;
  const borderW = state === 'claimable' ? 2 : milestone ? 1.8 : 1.2;

  const box = sketchPanel(w, h, { fill: fillColor, border: borderColor, width: borderW, seed: seedFor(x, y + level, w) });
  box.x = x; box.y = y;
  parent.addChild(box);

  // Level badge (+ a gold star flag on milestone rows).
  const lvlTxt = txt(t('battlepass.level', { n: String(level) }), snapFont(Math.round(h * 0.32)), C.mid);
  lvlTxt.anchor.set(0, 0); lvlTxt.x = x + Math.round(w * 0.05); lvlTxt.y = y + Math.round(h * 0.08);
  parent.addChild(lvlTxt);
  if (milestone) {
    const stSz = Math.round(h * 0.26);
    const star = buildIcon('star', stSz, C.gold);
    star.x = lvlTxt.x + lvlTxt.width + Math.round(w * 0.03); star.y = y + Math.round(h * 0.06);
    parent.addChild(star);
  }

  // State overlay, anchored to the cell's bottom-right corner. A GLYPH for the three states that
  // are facts (claimed / locked / pass-required) and a WORD only for `claimable`, which is an
  // affordance rather than a status — the split `ui/widgets/statusTag.ts` describes, resolved here
  // the way a forty-cell grid wants it rather than through that widget.
  //
  // Glyph-only because of the repetition: at Lv.1 thirty-nine of the forty cells are locked, so
  // `[lock] Locked` would print the same word thirty-nine times — visibly busier (compared side by
  // side, 2026-09-15) and saying nothing the lock does not. A one-off row is the opposite case and
  // keeps its word; see the achievement and recharge rows. It also retires the German case the
  // reward band below was patched for twice: `Gesperrt` reserved 282 px of a 465-wide cell, a lock
  // reserves one glyph.
  //
  // Drawn BEFORE the reward so the reward knows how much of the row is already spoken for. The two
  // used to be laid out independently — the reward group centred on the cell, the state label
  // pinned bottom-right — which is fine in landscape and drew "×2" straight through "Claim" on
  // every row in portrait, where the cell is 170 CSS px wide (portrait sweep §49).
  const anchorX = x + w - Math.round(w * 0.05);
  const anchorY = y + h - Math.round(h * 0.08);
  const stateFS = snapFont(Math.round(h * 0.34));
  // One glyph box for all three, so a column of cells never steps between two lock sizes. Derived
  // from the state font the way `ui/widgets/statusTag.ts` derives its own, so a battle-pass lock
  // and an achievement row's check read at the same weight.
  const tagH = Math.round(stateFS * 1.35);
  let reserveW = 0;
  if (state === 'claimable') {
    const sl = txt(t('battlepass.claim'), stateFS, C.green, true);
    sl.anchor.set(1, 1); sl.x = anchorX; sl.y = anchorY;
    parent.addChild(sl);
    reserveW = sl.width;
  } else {
    // Gold for pass_required (it is the paid track advertising itself), muted for the other two.
    const glyph = buildIcon(
      state === 'claimed' ? 'check' : 'lock', tagH, state === 'pass_required' ? C.gold : C.mid,
    );
    glyph.x = anchorX - tagH; glyph.y = anchorY - tagH;
    parent.addChild(glyph);
    reserveW = tagH;
  }

  // Reward: picture + amount, resolved through the shared `buildRewardIcon` (render/rewardIcon.ts)
  // so a battle-pass coin/material/skin looks identical to the same reward on the daily, event and
  // recharge screens. Coins get an escalating pile icon so a 20-coin drop and a 520-coin jackpot
  // read differently.
  if (reward) {
    const rewardColor = state === 'claimed' ? C.mid : reward.kind === 'coins' ? C.gold : C.accent;
    const cy = y + h * 0.62;
    const ic = Math.round(h * 0.5);
    // The band left of the state label is what the reward has to live in. No `Math.max(ic, …)`
    // floor on it (2026-09-12): that silently handed the group back a width the band did not have
    // whenever the state label was wide, which is exactly German's case — "Gesperrt" reserves 282
    // design px of a 465-wide cell and the ×N group then ran 36 px into it on five rows of every
    // German phone (sweep §50.12).
    const pad = Math.round(w * 0.05);
    const bandX = x + pad;
    const bandW = Math.max(24, w - pad * 2 - (reserveW > 0 ? reserveW + pad : 0));
    if (reward.kind === 'skin') {
      // Skins are singletons — glyph alone, centred in the band, shrunk if the band is narrower.
      const skinIc = Math.min(ic, bandW);
      const skinGlyph = buildRewardIcon(reward, skinIc, rewardColor) ?? buildIcon('capsule', skinIc, rewardColor);
      skinGlyph.x = bandX + bandW / 2 - skinIc / 2; skinGlyph.y = cy - skinIc / 2;
      parent.addChild(skinGlyph);
    } else {
      const gap = Math.round(w * 0.02);
      const size = snapFont(Math.round(h * 0.4));
      const probe = txt(`×${reward.count}`, size, rewardColor, state === 'claimable');
      // A five-digit reward in a narrow cell steps down the scale rather than running into the
      // state label — never below the legibility floor (render/fontScale.ts).
      const fitted = fitFont(size, ic + gap + probe.width, bandW);
      const rew = fitted === size ? probe : txt(`×${reward.count}`, fitted, rewardColor, state === 'claimable');
      if (rew !== probe) probe.destroy({ texture: true, baseTexture: true });
      // ...and then the GLYPH takes whatever the number left, rather than both overflowing
      // together. `fitFont` stops at the floor, so past that point the picture is the only thing
      // still able to yield — the same order of sacrifice the equipment cell's affix column uses
      // (§50.11 #2). Below a third of its nominal box it stops reading as the item it depicts, so
      // there it is dropped and the count stands alone.
      const icFit = Math.min(ic, Math.max(0, bandW - gap - rew.width));
      // `BpRewardKind` is a closed coins|material|skin union, so the null branch is only reachable
      // if the server grows a kind this client doesn't know — same generic glyph mail.ts uses there.
      const glyph = icFit >= ic * 0.34
        ? (buildRewardIcon(reward, icFit, rewardColor) ?? buildIcon('capsule', icFit, rewardColor))
        : null;
      const leadW = glyph ? icFit + gap : 0;
      const groupW = leadW + rew.width;
      const gx = bandX + Math.max(0, (bandW - groupW) / 2);
      if (glyph) { glyph.x = gx; glyph.y = cy - icFit / 2; parent.addChild(glyph); }
      rew.anchor.set(0, 0.5); rew.x = gx + leadW; rew.y = cy;
      parent.addChild(rew);
    }
  }
}
