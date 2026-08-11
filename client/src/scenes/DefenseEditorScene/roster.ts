// Attack-mode body (formation grid + card roster) rendering for the defense editor — split out of
// render.ts (2026-08-11, form ① independent function module per claudedocs/client-modules.md's
// split-form priority note) purely to keep render.ts under the 500-line convention. Only ever
// called from RenderPanel's own methods (each now a one-line delegate), so these take `core`
// explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { cardInstanceArtUrl } from '../../render/cardArt';
import type { UnitType } from '@nw/engine/types';
import type { CardInstance } from '../../game/meta/SaveData';
import { PAD } from './core';
import type { DefenseEditorSceneCore } from './core';
import { renderGrid, drawArtFit } from './grid';

/**
 * Attack mode body: left half = formation grid (place cards into cells), right half = a scrollable
 * vertical card roster to pick from — mirrors 布阵(left)/选卡(right) so both stay visible together
 * instead of the old horizontal palette strip forcing a page-flip to see more cards.
 */
export function renderAttackBody(core: DefenseEditorSceneCore, top: number, bottom: number): void {
  const { w } = core;
  const gap = PAD;
  const leftW = Math.floor((w - PAD * 2 - gap) / 2);
  const rightX = PAD + leftW + gap;
  const rightW = w - PAD - rightX;

  const toolbarH = 60;
  renderAttackToolbar(core, PAD, top, leftW, toolbarH);
  renderGrid(core, top + toolbarH + 6, bottom, PAD, leftW);

  core.rosterX = rightX;
  core.rosterY = top;
  core.rosterW = rightW;
  core.rosterH = bottom - top;
  renderCardRosterPanel(core, rightX, top, rightW, bottom - top);
}

/** Hint text + 自动回城 toggle + erase toggle, sized to the left (grid) half only. */
export function renderAttackToolbar(
  core: DefenseEditorSceneCore,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const eraseW = 60,
    eraseH = h - 6;
  const eraseX = x + w - eraseW;

  // 占领后自动回城 toggle (2026-07-23): a compact pill just left of the erase toggle. Off (default) = the team
  // stays stationed on a captured/moved-to tile; on = it marches home afterward.
  const arActive = core.autoReturn;
  const arW = 116,
    arH = eraseH;
  const arX = eraseX - 8 - arW;
  const arBox = sketchPanel(arW, arH, {
    fill: arActive ? C.gold : C.paper,
    border: arActive ? C.dark : C.gold,
    width: arActive ? 2.4 : 1.4,
    seed: seedFor(arX, y, arW),
  });
  arBox.x = arX;
  arBox.y = y + 3;
  core.bodyLayer.addChild(arBox);
  const arLbl = txt(
    `${t('world.team.autoReturn')} ${arActive ? '✓' : '✕'}`,
    FS.micro,
    arActive ? C.dark : C.gold,
    true
  );
  arLbl.anchor.set(0.5, 0.5);
  arLbl.x = arBox.x + arW / 2;
  arLbl.y = arBox.y + arH / 2;
  if (arLbl.width > arW - 8) arLbl.scale.set((arW - 8) / arLbl.width);
  core.bodyLayer.addChild(arLbl);
  core.hits.push({
    rect: { x: arBox.x, y: arBox.y, w: arW, h: arH },
    action: () => {
      core.autoReturn = !core.autoReturn;
      core.render();
    },
  });

  // 领队 tool (2026-07-25): armed like the erase toggle — while it's active, tapping a placed card
  // makes that card the team's icon. Deliberately NOT a fixed "leader cell" on the grid: the leader is
  // an identity, and tying it to a square would force the player to break their formation to change it.
  const ldActive = core.tool.kind === 'leader';
  const ldW = 76,
    ldH = eraseH;
  const ldX = arX - 8 - ldW;
  const ldBox = sketchPanel(ldW, ldH, {
    fill: ldActive ? C.accent : C.paper,
    border: ldActive ? C.dark : C.accent,
    width: ldActive ? 2.4 : 1.4,
    seed: seedFor(ldX, y, ldW),
  });
  ldBox.x = ldX;
  ldBox.y = y + 3;
  core.bodyLayer.addChild(ldBox);
  const ldLbl = txt(`★ ${t('world.team.leader')}`, FS.micro, ldActive ? C.light : C.accent, true);
  ldLbl.anchor.set(0.5, 0.5);
  ldLbl.x = ldBox.x + ldW / 2;
  ldLbl.y = ldBox.y + ldH / 2;
  if (ldLbl.width > ldW - 8) ldLbl.scale.set((ldW - 8) / ldLbl.width);
  core.bodyLayer.addChild(ldLbl);
  core.hits.push({
    rect: { x: ldBox.x, y: ldBox.y, w: ldW, h: ldH },
    action: () => {
      core.tool = ldActive ? { kind: 'erase' } : { kind: 'leader' };
      core.render();
    },
  });

  const hint = txt(
    core.tool.kind === 'leader' ? t('world.team.leaderHint') : t('world.team.hint'),
    FS.micro,
    C.mid
  );
  hint.anchor.set(0, 0.5);
  hint.x = x;
  hint.y = y + h / 2;
  const hintMax = ldX - 8 - x;
  if (hint.width > hintMax) hint.scale.set(hintMax / hint.width);
  core.bodyLayer.addChild(hint);

  const eraseActive = core.tool.kind === 'erase';
  const box = sketchPanel(eraseW, eraseH, {
    fill: eraseActive ? C.red : C.paper,
    border: eraseActive ? C.dark : C.red,
    width: eraseActive ? 2.4 : 1.4,
    seed: seedFor(eraseX, y, eraseW),
  });
  box.x = eraseX;
  box.y = y + 3;
  core.bodyLayer.addChild(box);
  const lbl = txt(t('world.defense.erase'), FS.micro, eraseActive ? C.light : C.red, true);
  lbl.anchor.set(0.5, 0.5);
  lbl.x = box.x + eraseW / 2;
  lbl.y = box.y + eraseH / 2;
  core.bodyLayer.addChild(lbl);
  core.hits.push({
    rect: { x: box.x, y: box.y, w: eraseW, h: eraseH },
    action: () => {
      core.tool = { kind: 'erase' };
      core.render();
    },
  });
}

/** Right-half card roster: a scrollable portrait-card grid (mirrors TeamsScene's roster grid). */
export function renderCardRosterPanel(
  core: DefenseEditorSceneCore,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const cards = core.availableCards();
  const titleH = 22;
  const title = txt(t('roster.title'), FS.micro, C.mid);
  title.x = x;
  title.y = y + 2;
  core.bodyLayer.addChild(title);

  const listY = y + titleH;
  const availH = h - titleH;
  if (cards.length === 0) {
    const empty = txt(t('world.team.noCards'), FS.micro, C.mid);
    empty.x = x;
    empty.y = listY + 8;
    core.bodyLayer.addChild(empty);
    core.scrollMax = 0;
    return;
  }

  const gap = 8;
  const cellWTarget = 168,
    cellH = 96;
  const cols = Math.max(1, Math.floor((w + gap) / (cellWTarget + gap)));
  const cellW = (w - gap * (cols - 1)) / cols;
  const rows = Math.ceil(cards.length / cols);
  const totalH = rows * (cellH + gap) + gap;
  // Naive availH (not peekViewportH's shrunk value): rows are drawn in full or skipped
  // entirely, never cropped, so a shrunk viewport would just exclude a row that fits fine and
  // leave a dead gap (2026-07-23 correction, UI_DESIGN.md §25).
  core.scrollMax = Math.max(0, totalH - availH);
  core.scrollY = Math.max(0, Math.min(core.scrollY, core.scrollMax));

  // Cards render into a masked sub-layer so an overscrolled row never bleeds up past listY and
  // paints over the toolbar/title above it (the cull below only skips rows fully outside
  // [listY, listY+availH], so a row straddling that edge would otherwise render in full).
  const rosterLayer = new PIXI.Container();
  core.bodyLayer.addChild(rosterLayer);
  const clip = new PIXI.Graphics();
  clip.beginFill(0xffffff).drawRect(x, listY, w, availH).endFill();
  core.bodyLayer.addChild(clip);
  rosterLayer.mask = clip;
  const outerLayer = core.bodyLayer;
  core.bodyLayer = rosterLayer;
  cards.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = x + col * (cellW + gap);
    const cy = listY + gap + row * (cellH + gap) - core.scrollY;
    if (cy + cellH >= listY && cy <= listY + availH)
      renderRosterCell(core, c, cx, cy, cellW, cellH);
  });
  core.bodyLayer = outerLayer;

  drawScrollIndicator(core.bodyLayer, { x, y: listY, w, h: availH }, core.scrollY, core.scrollMax);
}

export function renderRosterCell(
  core: DefenseEditorSceneCore,
  c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
  x: number,
  y: number,
  cellW: number,
  cellH: number
): void {
  const active = core.tool.kind === 'card' && core.tool.cardInstanceId === c.card.id;
  const placed = core.cellForCard(c.card.id) !== undefined;
  const pad = 6;
  const box = sketchPanel(cellW, cellH, {
    fill: active ? C.accent : 0xfaf9f5,
    border: active ? C.dark : placed ? C.accent : C.mid,
    width: active ? 2.4 : 1.4,
    seed: seedFor(x, y, cellW),
  });
  box.x = x;
  box.y = y;
  core.bodyLayer.addChild(box);

  const imgH = cellH - pad * 2;
  const imgW = Math.round(imgH * 0.72);
  const frame = sketchPanel(imgW, imgH, {
    fill: 0xf0eee7,
    border: C.mid,
    seed: seedFor(x, y, imgW),
  });
  frame.x = x + pad;
  frame.y = y + pad;
  core.bodyLayer.addChild(frame);
  const artUrl = cardInstanceArtUrl(c.card, core.cb.getSave?.()?.equipped);
  if (artUrl) drawArtFit(core, artUrl, x + pad + 1, y + pad + 1, imgW - 2, imgH - 2);

  const ax = x + pad + imgW + 8;
  const rightW = Math.max(10, x + cellW - pad - ax);
  const name = t(`card.${c.card.defId}.name` as import('../../i18n').TranslationKey);
  const nameLbl = txt(`${name} Lv.${c.card.level}`, FS.micro, active ? C.light : C.dark, true);
  nameLbl.x = ax;
  nameLbl.y = y + pad;
  if (nameLbl.width > rightW) nameLbl.scale.set(Math.max(0.5, rightW / nameLbl.width));
  core.bodyLayer.addChild(nameLbl);

  const troopLbl = txt(`${c.troops}/${c.cap}`, FS.micro, active ? C.light : C.mid);
  troopLbl.x = ax;
  troopLbl.y = y + pad + 18;
  core.bodyLayer.addChild(troopLbl);

  if (placed) {
    const tag = txt(`[${t('roster.inTeam')}]`, FS.micro, active ? C.light : C.accent, true);
    tag.x = ax;
    tag.y = y + pad + 36;
    core.bodyLayer.addChild(tag);
  }

  const rect = { x, y, w: cellW, h: cellH };
  core.hits.push({
    rect,
    action: () => {
      core.tool = { kind: 'card', cardInstanceId: c.card.id, unitType: c.unitType };
      core.render();
    },
  });
  // Also expose this cell for drag-to-place (arm a drag candidate on pointer-down over it).
  core.rosterCardHits.push({ rect, cardId: c.card.id, unitType: c.unitType });
}
