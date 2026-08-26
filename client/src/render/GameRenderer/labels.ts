// Pure rendering helpers for the two battle-scene name labels that don't belong to any per-tick
// domain (input/events): the replay-only base/viewpoint name plates and the netplay opponent-nickname
// pill. Both are drawn once from GameRendererCore.buildSceneGraph() (core.ts) and never touched again,
// so — unlike input.ts/events.ts — they don't need to be a stateful class; free functions that take
// `core` explicitly (form① — see claudedocs/client-modules.md's split-form priority note) keep
// core.ts under the 500-line convergence line without inventing a delegate method on Core for
// something only Core itself calls.
import * as PIXI from 'pixi.js-legacy';
import { makeText } from '../pixiText';
import { drawHudButton } from '../../ui/widgets/hudButton';
import { snapFont } from '../fontScale';
import { factionInk } from '../theme';
import type { Rect } from '../../layout/ILayout';
import type { GameRendererCore } from './core';

/**
 * The shared "name chip": a secondary HUD button sized to the label it holds, placed by
 * `place(bw, bh)` (so the caller can right-align / fall back on the measured width).
 * One helper for both the netplay opponent pill and the replay viewpoint pair, so the
 * two never drift apart visually. Returns the chip's rect (used as a tap region).
 */
function drawNameChip(
  core: GameRendererCore,
  name: string,
  fill: number,
  bh: number,
  place: (bw: number, bh: number) => { x: number; y: number },
): Rect {
  const label = makeText(name || '?', {
    fontSize: snapFont(Math.max(12, Math.round(bh * 0.5))),
    fill, fontWeight: 'bold', fontFamily: 'monospace',
  });
  const padX = 14;
  const bw = Math.ceil(label.width) + padX * 2;
  const { x, y } = place(bw, bh);

  const bg = new PIXI.Graphics();
  drawHudButton(bg, bw, bh, 'secondary', { radius: 4 });
  bg.x = x;
  bg.y = y;

  label.anchor.set(0.5);
  label.x = x + bw / 2;
  label.y = y + bh / 2;

  core.container.addChild(bg, label);
  return { x, y, w: bw, h: bh };
}

/**
 * Replay-only name labels (S1-RP): one name chip per HP bar, the same presentation netplay
 * uses for the opponent (drawOpponentLabel) — enemy left of the top-strip HP bar, viewpoint
 * player on its own HP bar in the bottom-left column. Whose name sits on *our* bar is what
 * makes the current viewpoint unambiguous, so this replaces both the old "View: <name>" text
 * tag and the pair of name plates that used to float over the two bases (the plates said
 * nothing the HP bars don't: the layout already puts the viewed side's base on the near side,
 * exactly as it does for a netplay joiner — see LandscapeLayout.playerBaseRect).
 * Names come from `core.replayNames` (owner-indexed); no-op outside replay (gated by the caller).
 */
export function drawReplayNameLabels(core: GameRendererCore): void {
  const names = core.replayNames!;
  const localName = names[core.localOwner];
  const enemyName = names[core.localOwner === 0 ? 1 : 0];

  // Enemy chip — left of the top-strip HP bar, exactly where netplay puts the opponent's
  // nickname (drawOpponentLabel). Shorter than that one, and centered on the HP bar rather
  // than on the strip: playback hides the surrender button (so there's no button band to
  // borrow) and ReplayScene's progress bar runs along the strip's bottom edge, which a
  // strip-centered 44px chip would collide with.
  const topR = core.layout.hudTopRect;
  const eHp = core.hudView.getEnemyHpRect();
  const CHIP_H = 34;
  drawNameChip(core, enemyName, factionInk.enemy, CHIP_H, (bw, bh) => ({
    x: eHp.x - 12 - bw,
    // Centered on the HP bar, then lifted if that would reach into the strip's bottom
    // quarter — where ReplayScene's progress bar (drawn on top of us) runs.
    y: Math.max(
      topR.y + 2,
      Math.min(Math.round(eHp.y + eHp.h / 2 - bh / 2), Math.round(topR.y + topR.h * 0.72) - bh),
    ),
  }));

  // Viewpoint chip — on our own HP bar, mirroring the enemy's. Preferred spot is left of the
  // bar (portrait, where the bar is board-centered and the strip has room to its left); the
  // landscape info column is only ~50px wider than the bar itself, so there it falls back to
  // the top of the column — above the ink count and the bar, where the old "View:" tag sat.
  const pHp = core.hudView.getPlayerHpRect();
  const col = core.layout.hudBottomLeftRect;
  drawNameChip(core, localName, factionInk.friend, CHIP_H, (bw, bh) => {
    const leftX = pHp.x - 12 - bw;
    return leftX >= col.x + 8
      ? { x: leftX, y: Math.round(pHp.y + pHp.h / 2 - bh / 2) }
      : { x: pHp.x + pHp.w - bw, y: Math.round(col.y + 3) };
  });
}

/**
 * Opponent nickname on the top HUD strip, in a shared-style button background
 * sitting just left of the (board-centered) enemy HP bar — so the name reads
 * right before the opponent's HP. The profile-tap region is tightened to this
 * button. Vertical band / height reuse the surrender button's.
 */
export function drawOpponentLabel(core: GameRendererCore): void {
  const sr = core.hudView.getSurrenderRect();
  const hp = core.hudView.getEnemyHpRect();
  const rect = drawNameChip(core, core.oppProfile!.name, factionInk.enemy, sr.h, (bw) => ({
    x: hp.x - 12 - bw,  // gap of 12px before the enemy HP bar
    y: sr.y,
  }));
  core.hudView.setEnemyInfoRect(rect);
}
