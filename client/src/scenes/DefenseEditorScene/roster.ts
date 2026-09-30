// Attack-mode body (formation grid + card roster) rendering for the defense editor — split out of
// render.ts (2026-08-11, form ① independent function module per claudedocs/client-modules.md's
// split-form priority note) purely to keep render.ts under the 500-line convention. Only ever
// called from RenderPanel's own methods (each now a one-line delegate), so these take `core`
// explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor, fitOrWrap } from '../../render/sketchUi';
import { FS } from '../../render/fontScale';
import { drawScrollIndicator } from '../../ui/widgets/ScrollIndicator';
import { fitToWidth } from '../../ui/widgets/truncateText';
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

  const toolbarH = renderAttackToolbar(core, PAD, top, leftW);
  renderGrid(core, top + toolbarH + 6, bottom, PAD, leftW);

  core.rosterX = rightX;
  core.rosterY = top;
  core.rosterW = rightW;
  core.rosterH = bottom - top;
  renderCardRosterPanel(core, rightX, top, rightW, bottom - top);
}

/** Height of the toggle row; the pills are 6 shorter, which leaves room for a two-line label. */
const TOOL_ROW_H = 60;

/**
 * Toggle row (领队 / 自动回城 / erase) over the grid, and the hint on its own line(s) under it — sized
 * to the left (grid) half only. Returns the height it took.
 *
 * The hint used to share the toggle row and be squeezed into whatever the three pills left over:
 * ~250 design px in portrait for a ~980 px English sentence, drawn at 0.25 (5 design px against a
 * floor of 20), and the pills' own labels were squeezed into fixed 76 / 116 px boxes the same way
 * (2026-09-29). Now the pills are sized from their labels, a label that still does not fit goes
 * onto two lines, and the hint wraps across the full width of the grid.
 */
export function renderAttackToolbar(core: DefenseEditorSceneCore, x: number, y: number, w: number): number {
  const pillH = TOOL_ROW_H - 6;
  const gap = 8;
  const arActive = core.autoReturn;
  const ldActive = core.tool.kind === 'leader';
  const eraseActive = core.tool.kind === 'erase';

  // Right to left: erase, 自动回城, 领队. 自动回城 (2026-07-23) — off (default) = the team stays
  // stationed on a captured/moved-to tile; on = it marches home afterward. 领队 (2026-07-25) is armed
  // like the erase toggle: while active, tapping a placed card makes that card the team's icon —
  // deliberately not a fixed "leader cell", which would force breaking the formation to change it.
  const pills = [
    {
      label: t('world.defense.erase'), minW: 60,
      fill: eraseActive ? C.red : C.paper, border: eraseActive ? C.dark : C.red, active: eraseActive,
      ink: eraseActive ? C.light : C.red,
      fn: () => { core.tool = { kind: 'erase' }; core.render(); },
    },
    {
      label: `${t('world.team.autoReturn')} ${arActive ? '✓' : '✕'}`, minW: 116,
      fill: arActive ? C.gold : C.paper, border: arActive ? C.dark : C.gold, active: arActive,
      ink: arActive ? C.dark : C.gold,
      fn: () => { core.autoReturn = !core.autoReturn; core.render(); },
    },
    {
      label: `★ ${t('world.team.leader')}`, minW: 76,
      fill: ldActive ? C.accent : C.paper, border: ldActive ? C.dark : C.accent, active: ldActive,
      ink: ldActive ? C.light : C.accent,
      fn: () => { core.tool = ldActive ? { kind: 'erase' } : { kind: 'leader' }; core.render(); },
    },
  ];
  const labels = pills.map((p) => txt(p.label, FS.micro, p.ink, true));
  const widths = pills.map((p, i) => Math.max(p.minW, Math.ceil(labels[i]!.width) + 16));
  // Short of room (portrait German), 自动回城 — the longest — gives up width first and wraps.
  const over = widths.reduce((sum, bw) => sum + bw, 0) + gap * (pills.length - 1) - w;
  if (over > 0) widths[1] = Math.max(60, widths[1]! - over);

  let right = x + w;
  pills.forEach((p, i) => {
    const bw = widths[i]!;
    const bx = right - bw;
    const box = sketchPanel(bw, pillH, {
      fill: p.fill, border: p.border, width: p.active ? 2.4 : 1.4, seed: seedFor(bx, y, bw),
    });
    box.x = bx;
    box.y = y + 3;
    core.bodyLayer.addChild(box);
    const lbl = labels[i]!;
    lbl.anchor.set(0.5, 0.5);
    fitOrWrap(lbl, bw - 8);
    lbl.x = bx + bw / 2;
    lbl.y = box.y + pillH / 2;
    core.bodyLayer.addChild(lbl);
    core.hits.push({ rect: { x: bx, y: box.y, w: bw, h: pillH }, fn: p.fn });
    right = bx - gap;
  });

  // The hint swaps text with the leader tool; the row keeps the taller of the two so arming the tool
  // does not shift the grid under the player's finger.
  const hintKeys = ['world.team.hint', 'world.team.leaderHint'] as const;
  const hintH = Math.max(...hintKeys.map((k) => {
    const probe = txt(t(k), FS.micro, C.mid);
    fitOrWrap(probe, w, 'left');
    const hh = probe.height;
    probe.destroy({ texture: true, baseTexture: true });
    return hh;
  }));
  const hint = txt(ldActive ? t('world.team.leaderHint') : t('world.team.hint'), FS.micro, C.mid);
  fitOrWrap(hint, w, 'left');
  hint.x = x;
  hint.y = y + TOOL_ROW_H + 2;
  core.bodyLayer.addChild(hint);
  return TOOL_ROW_H + 2 + Math.ceil(hintH);
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
  // Columns: as many 168-wide cells as fit, but never so narrow that the longest hero name on the
  // list does not fit beside the portrait at the floor size. "Chen Shou" needs ~99 design px and a
  // three-column portrait cell leaves ~88; the old answer scaled it (with "Lv.9" appended) to 0.58 of
  // the floor (2026-09-29). Chinese names, and short latin ones, keep three columns.
  const nameW = Math.max(0, ...cards.map((c) => {
    const probe = txt(rosterCardName(c.card), FS.micro, C.dark, true);
    const pw = probe.width;
    probe.destroy({ texture: true, baseTexture: true });
    return pw;
  }));
  const minCellW = Math.ceil(nameW) + rosterCellChromeW(cellH);
  const cols = Math.max(1, Math.min(
    Math.floor((w + gap) / (cellWTarget + gap)),
    Math.floor((w + gap) / (minCellW + gap)),
  ));
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

const ROSTER_CELL_PAD = 6;
/** Portrait frame width for a roster cell `cellH` tall. */
const rosterImgW = (cellH: number): number => Math.round((cellH - ROSTER_CELL_PAD * 2) * 0.72);
/** Everything in a roster cell's width that is not the text column: pads, portrait, gap. */
const rosterCellChromeW = (cellH: number): number => ROSTER_CELL_PAD * 2 + rosterImgW(cellH) + 8;
const rosterCardName = (card: CardInstance): string =>
  t(`card.${card.defId}.name` as import('../../i18n').TranslationKey);
/** Line pitch of the text column: an FS.micro line at the portrait floor is ~20 tall. */
const ROSTER_LINE = 20;

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
  const pad = ROSTER_CELL_PAD;
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
  const imgW = rosterImgW(cellH);
  // fillAlpha: 0 — see CardScene/list.ts's renderCardCell (2026-08-21): the cell behind is already
  // the one background layer, this frame is a stroke-only outline.
  const frame = sketchPanel(imgW, imgH, {
    fill: 0xf0eee7,
    fillAlpha: 0,
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
  // Name, then level on its own line — "Chen Shou Lv.9" on one line was the widest thing in the cell.
  const nameLbl = txt(rosterCardName(c.card), FS.micro, active ? C.light : C.dark, true);
  nameLbl.x = ax;
  nameLbl.y = y + pad;
  // The column count above makes room for every name on the list; this only guards a cell that is
  // narrower than that anyway (a one-column list on a very narrow panel).
  if (nameLbl.width > rightW) nameLbl.text = fitToWidth(nameLbl.text, FS.micro, rightW, true);
  core.bodyLayer.addChild(nameLbl);

  const lvLbl = txt(`Lv.${c.card.level}`, FS.micro, active ? C.light : C.dark);
  lvLbl.x = ax;
  lvLbl.y = y + pad + ROSTER_LINE;
  core.bodyLayer.addChild(lvLbl);

  const troopLbl = txt(`${c.troops}/${c.cap}`, FS.micro, active ? C.light : C.mid);
  troopLbl.x = ax;
  troopLbl.y = y + pad + ROSTER_LINE * 2;
  core.bodyLayer.addChild(troopLbl);

  if (placed) {
    const tag = txt(`[${t('roster.inTeam')}]`, FS.micro, active ? C.light : C.accent, true);
    tag.x = ax;
    tag.y = y + pad + ROSTER_LINE * 3;
    if (tag.width > rightW) tag.text = fitToWidth(tag.text, FS.micro, rightW, true);
    core.bodyLayer.addChild(tag);
  }

  const rect = { x, y, w: cellW, h: cellH };
  core.hits.push({
    rect,
    fn: () => {
      core.tool = { kind: 'card', cardInstanceId: c.card.id, unitType: c.unitType };
      core.render();
    },
  });
  // Also expose this cell for drag-to-place (arm a drag candidate on pointer-down over it).
  core.rosterCardHits.push({ rect, cardId: c.card.id, unitType: c.unitType });
}
