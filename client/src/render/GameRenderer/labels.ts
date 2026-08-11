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
import { t } from '../../i18n';
import type { Rect } from '../../layout/ILayout';
import type { GameRendererCore } from './core';

/**
 * Replay-only name labels (S1-RP). Two pieces:
 *  • a name plate above each base — the local (viewpoint) side over `playerBaseRect`,
 *    the opponent over `enemyBaseRect`, keyed off `localOwner` so they follow a viewpoint flip;
 *  • a "View: <name>" tag in the bottom-left strip so the current viewpoint is unambiguous.
 * Both read from `core.replayNames` (owner-indexed); no-op outside replay (gated by the caller).
 */
export function drawReplayNameLabels(core: GameRendererCore): void {
  const names = core.replayNames!;
  const localName = names[core.localOwner];
  const enemyName = names[core.localOwner === 0 ? 1 : 0];

  // Base name plates (over each base, centered on the base rect's top edge).
  const plate = (name: string, rect: Rect): void => {
    const label = makeText(name, {
      fontSize: snapFont(22), fill: 0x333333, fontWeight: 'bold', fontFamily: 'monospace',
    });
    const padX = 12;
    const bw = Math.ceil(label.width) + padX * 2;
    const bh = Math.ceil(label.height) + 8;
    const bx = Math.round(rect.x + rect.w / 2 - bw / 2);
    const by = Math.round(rect.y - bh - 6);
    const bg = new PIXI.Graphics();
    drawHudButton(bg, bw, bh, 'secondary', { radius: 4 });
    bg.x = bx; bg.y = by;
    label.anchor.set(0.5);
    label.x = bx + bw / 2;
    label.y = by + bh / 2;
    core.container.addChild(bg, label);
  };
  plate(localName, core.layout.playerBaseRect());
  plate(enemyName, core.layout.enemyBaseRect());

  // Current-viewpoint tag in the bottom-left strip (above the ink counter).
  const vp = makeText(t('replay.viewpoint', { name: localName }), {
    fontSize: snapFont(22), fill: 0x2a5599, fontWeight: 'bold', fontFamily: 'monospace',
  });
  const bl = core.layout.hudBottomLeftRect;
  vp.x = Math.round(bl.x + 14);
  vp.y = Math.round(bl.y + 6);
  core.container.addChild(vp);
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
  const label = makeText(core.oppProfile!.name || '?', {
    fontSize: snapFont(Math.max(12, Math.round(sr.h * 0.5))),
    fill: factionInk.enemy, fontWeight: 'bold', fontFamily: 'monospace',
  });

  const padX = 14;
  const bw = Math.ceil(label.width) + padX * 2;
  const bh = sr.h;
  const bx = hp.x - 12 - bw;  // gap of 12px before the enemy HP bar
  const by = sr.y;

  const bg = new PIXI.Graphics();
  drawHudButton(bg, bw, bh, 'secondary', { radius: 4 });
  bg.x = bx;
  bg.y = by;

  label.anchor.set(0.5);
  label.x = bx + bw / 2;
  label.y = by + bh / 2;

  core.container.addChild(bg, label);
  core.hudView.setEnemyInfoRect({ x: bx, y: by, w: bw, h: bh });
}
