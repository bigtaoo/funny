// VS overlay construction — split out of build.ts (2026-08-12, form ① independent function module
// per claudedocs/client-modules.md's split-form priority note) purely to keep build.ts under the
// 500-line convention. Builds the (initially hidden) full-screen "you vs opponent" card layer shown
// while the local-AI match state machine (see matchState.ts) is in its 'vs' state. Only ever called
// once from BuildPanel's own build(), so this stays a plain function rather than a domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { SketchPen } from '../../render/sketch';
import { C, txt, sketchPanel, type LobbySceneCore } from './core';
import { FS, snapFont } from '../../render/fontScale';

export function buildVsLayer(core: LobbySceneCore): PIXI.Container {
  const { w, h } = core;
  const c = new PIXI.Container();

  const dim = new PIXI.Graphics();
  dim.beginFill(0x000000, 0.82);
  dim.drawRect(0, 0, w, h);
  dim.endFill();
  c.addChild(dim);

  const cardW = Math.round(w * 0.62);
  const cardH = Math.round(h * 0.12);
  const cardX = (w - cardW) / 2;

  const youCard = buildPlayerCard(cardW, cardH, t('lobby.you'), C.accent);
  youCard.x = cardX; youCard.y = Math.round(h * 0.28);
  c.addChild(youCard);

  const vs = txt(t('lobby.vs'), FS.display, C.gold, true);
  vs.anchor.set(0.5, 0.5); vs.x = w / 2; vs.y = h * 0.5;
  c.addChild(vs);

  const oppCard = buildPlayerCard(cardW, cardH, '', C.red);
  oppCard.x = cardX; oppCard.y = Math.round(h * 0.58);
  c.addChild(oppCard);
  core.oppLabel = oppCard.getChildByName('nameLabel') as PIXI.Text;

  const hint = txt(t('lobby.loading'), FS.label, C.mid);
  hint.anchor.set(0.5, 0); hint.x = w / 2; hint.y = h * 0.8;
  c.addChild(hint);

  return c;
}

function buildPlayerCard(w: number, h: number, name: string, accentColor: number): PIXI.Container {
  // Seed by side colour so the you/opp cards scrawl differently.
  const bg = sketchPanel(w, h, { fill: C.paper, border: accentColor, width: 2.4, seed: accentColor });
  // Ink accent stroke down the left edge.
  new SketchPen(bg, accentColor ^ 0x55).line(4, 5, 4, h - 5, { color: accentColor, width: 5, jitter: 0.8, taper: 0.85 });
  const nameLabel = txt(name, snapFont(Math.round(h * 0.45)), C.dark, true);
  nameLabel.name = 'nameLabel'; nameLabel.anchor.set(0, 0.5);
  nameLabel.x = Math.round(w * 0.08); nameLabel.y = h / 2;
  bg.addChild(nameLabel);
  return bg;
}
