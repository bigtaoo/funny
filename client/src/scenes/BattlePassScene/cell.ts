import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { snapFont } from '../../render/fontScale';
import { buildCoinIcon } from '../../render/atlas/coinIconAtlas';

// ── Pure reward-cell drawing helpers for BattlePassScene ──────────────────────
//
// Extracted from the scene class (form① partial split, client-modules.md §split
// convention): fully parameterized, zero `this.` — render()'s per-level loop
// stays on the class, only the per-cell drawing/state math moved out.

/** Four cell states for a single reward cell */
export type CellState = 'claimable' | 'claimed' | 'locked' | 'pass_required';

/**
 * Coin reward → escalating pile glyph so larger payouts read visibly richer at a glance
 * (single coin → cluster → stack → sack → chest). Milestone jackpots become chests.
 */
function coinIconTier(count: number): IconKind {
  if (count >= 300) return 'coinChest';
  if (count >= 150) return 'coinSack';
  if (count >= 80) return 'coinStack';
  if (count >= 40) return 'coins';
  return 'coin';
}

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

  // Reward: hand-drawn glyph + amount. Coins use an escalating pile icon (coinIconTier) so a
  // 20-coin drop and a 520-coin jackpot read differently; materials use their craft icon.
  if (reward) {
    const iconKind: IconKind =
      reward.kind === 'coins' ? coinIconTier(reward.count)
        : reward.kind === 'skin' ? 'brush'
          : reward.id === 'lead' ? 'lead'
            : reward.id === 'binding' ? 'binding'
              : 'scrap';
    const rewardColor = state === 'claimed' ? C.mid : reward.kind === 'coins' ? C.gold : C.accent;
    const cy = y + h * 0.62;
    const ic = Math.round(h * 0.5);
    const glyph = reward.kind === 'coins'
      ? buildCoinIcon(iconKind, ic, rewardColor)
      : (iconKind === 'scrap' || iconKind === 'lead' || iconKind === 'binding')
        ? buildMaterialIcon(iconKind as MaterialKind, ic, rewardColor)
        : buildIcon(iconKind, ic, rewardColor);
    if (reward.kind === 'skin') {
      // Skins are singletons — glyph alone, centred.
      glyph.x = x + w / 2 - ic / 2; glyph.y = cy - ic / 2;
      parent.addChild(glyph);
    } else {
      const rew = txt(`×${reward.count}`, snapFont(Math.round(h * 0.4)), rewardColor, state === 'claimable');
      const gap = Math.round(w * 0.02);
      const groupW = ic + gap + rew.width;
      const gx = x + w / 2 - groupW / 2;
      glyph.x = gx; glyph.y = cy - ic / 2;
      rew.anchor.set(0, 0.5); rew.x = gx + ic + gap; rew.y = cy;
      parent.addChild(glyph, rew);
    }
  }

  // State overlay — pass_required shows a lock glyph; other states show a text label.
  // Both anchor to the cell's bottom-right corner.
  const anchorX = x + w - Math.round(w * 0.05);
  const anchorY = y + h - Math.round(h * 0.08);
  if (state === 'pass_required') {
    const lockSz = Math.round(h * 0.32);
    const lock = buildIcon('lock', lockSz, C.gold);
    lock.x = anchorX - lockSz; lock.y = anchorY - lockSz;
    parent.addChild(lock);
  } else {
    let stateLbl: string | null = null;
    if (state === 'claimed') stateLbl = t('battlepass.claimed');
    else if (state === 'locked') stateLbl = t('battlepass.locked');
    else if (state === 'claimable') stateLbl = t('battlepass.claim');

    if (stateLbl) {
      const stateColor = state === 'claimable' ? C.green : C.mid;
      const sl = txt(stateLbl, snapFont(Math.round(h * 0.34)), stateColor, state === 'claimable');
      sl.anchor.set(1, 1); sl.x = anchorX; sl.y = anchorY;
      parent.addChild(sl);
    }
  }
}
