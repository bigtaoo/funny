// Header title row + alliance buttons — split out of core.ts (2026-08-11, form ① independent
// function module per claudedocs/client-modules.md's split-form priority note) purely to keep
// core.ts under the 500-line convention. Only ever called from Core's own renderHeader(), so these
// take `core` explicitly instead of becoming their own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt, sketchPanel, seedFor } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { buildEmblemIcon, type EmblemKey } from '../../render/emblemIcon';
import { buildTitleIcon, backPillRightEdge } from '../../ui/widgets/SceneHeader';
import { FS } from '../../render/fontScale';
import type { SectSceneCore } from './core';

/** Header title row. Always shows the "Sect" title just right of the back pill. In landscape
 *  (where there's horizontal room) it also carries the sect identity that used to live in a
 *  separate hand-drawn band below the header — `[TAG] Name` + families count + prosperity
 *  centered, alliance buttons pinned far-right (see the 25.07.2026 header-declutter pass, which
 *  removed the stacked hand-drawn bands that used to crowd the top-left corner). Portrait keeps
 *  identity in the body below the header, since the narrow bar can't hold it all on one line. */
export function drawHeaderTitle(core: SectSceneCore, headerH: number): void {
  const { w, h } = core;
  for (const n of core.headerExtras) n.destroy();
  core.headerExtras = [];
  const add = <T extends PIXI.DisplayObject>(node: T): T => {
    core.headerExtras.push(node);
    core.container.addChild(node);
    return node;
  };
  const midY = headerH / 2;

  // Left cluster must clear the back-button pill — asked of SceneHeader rather than re-derived
  // from a copy of its chip formula, which went stale the moment the chip grew an arrow glyph.
  const leftBound = backPillRightEdge(h);

  const showIdentity = core.landscape && core.sect && core.mode === 'mySect';
  const gap = Math.round(w * 0.02);
  const sect = showIdentity ? core.sect! : null;

  // Build every node up front (unpositioned) so the whole cluster's width can be measured and
  // centered in the space between the back pill and the alliance buttons.
  // Batch-5 title glyph (pagoda), laid out as the same [icon][gap][title] group `drawSceneHeader`
  // builds — this scene passes `title: null` and owns the layout, so it positions the group itself
  // but takes `size`/`gap`/the ink rule from the shared builder.
  const titleIcon = buildTitleIcon('sectTabIcon', FS.headline, C.dark);
  add(titleIcon.node);
  const titleNode = add(txt(t('sect.title'), FS.headline, C.dark, true));
  let clusterW = titleIcon.size + titleIcon.gap + titleNode.width;

  // Emblem badge (family-emblem-art-prompts.md, 2026-08-14): same tinted-icon-or-dashed-placeholder
  // affordance as FamilyScene/header.ts — sect-leader-only tap target (isSectLeader, not just any
  // family leader), since the user decision restricts changing the sect badge to the sect leader.
  let emblemNode: PIXI.DisplayObject | null = null;
  const emblemSize = Math.round(h * 0.034);
  const isSectLeader = core.isSectLeader;
  if (sect) {
    const key = sect.emblemKey as EmblemKey | undefined;
    emblemNode = key ? buildEmblemIcon(key, emblemSize, sect.emblemColor ?? C.dark) : null;
    if (!emblemNode && isSectLeader) {
      const ph = new PIXI.Graphics();
      ph.lineStyle(1.4, C.mid, 0.9);
      ph.drawCircle(emblemSize / 2, emblemSize / 2, emblemSize / 2 - 1);
      ph.moveTo(emblemSize * 0.3, emblemSize / 2).lineTo(emblemSize * 0.7, emblemSize / 2);
      ph.moveTo(emblemSize / 2, emblemSize * 0.3).lineTo(emblemSize / 2, emblemSize * 0.7);
      emblemNode = ph;
    }
    if (emblemNode) { add(emblemNode); clusterW += emblemSize + 8; }
  }

  let nameNode: PIXI.Text | null = null;
  let famNode: PIXI.Text | null = null;
  let star: PIXI.DisplayObject | null = null;
  let starSize = 0;
  let prosNode: PIXI.Text | null = null;
  if (sect) {
    nameNode = add(txt(`[${sect.tag}] ${sect.name}`, FS.title, C.dark));
    famNode = add(txt(t('sect.families', { n: sect.memberFamilyCount }), FS.heading, C.mid));
    starSize = Math.round(h * 0.026);
    star = add(buildIcon('star', starSize, 0xd4a030));
    prosNode = add(txt(t('sect.prosperity', { n: sect.prosperity }), FS.heading, 0xa9750f));
    clusterW += gap + nameNode.width + gap + famNode.width + gap + starSize + 6 + prosNode.width;
  }

  // Alliance buttons pinned to the header's right edge — placed before centering so their width
  // is reserved from the available cluster space (mirrors FamilySceneBase pinning the member
  // count far-right before centering its own title cluster).
  const btnsLeftX = sect ? drawHeaderAllianceButtons(core, w - 16, headerH, add) : w - 16;
  const rightBound = sect ? btnsLeftX - gap : btnsLeftX;
  const available = rightBound - leftBound;
  let x = leftBound + Math.max(0, (available - clusterW) / 2);

  titleIcon.node.x = x; titleIcon.node.y = Math.round(midY - titleIcon.size / 2);
  x += titleIcon.size + titleIcon.gap;
  titleNode.anchor.set(0, 0.5); titleNode.x = x; titleNode.y = midY;
  x += titleNode.width;

  if (sect && nameNode && famNode && star && prosNode) {
    x += gap;
    if (emblemNode) {
      emblemNode.x = x; emblemNode.y = midY - emblemSize / 2;
      if (isSectLeader) core.hitRects.push({ rect: { x, y: midY - emblemSize / 2, w: emblemSize, h: emblemSize }, fn: () => core.emblemHooks.openEmblemPicker() });
      x += emblemSize + 8;
    }
    nameNode.anchor.set(0, 0.5); nameNode.x = x; nameNode.y = midY;
    x += nameNode.width + gap;

    famNode.anchor.set(0, 0.5); famNode.x = x; famNode.y = midY;
    x += famNode.width + gap;

    star.x = x; star.y = midY - starSize / 2;
    x += starSize + 6;
    prosNode.anchor.set(0, 0.5); prosNode.x = x; prosNode.y = midY;
  }
}

/** Alliance controls anchored to the header's right edge, laid out right-to-left. Viewing the
 *  ally list is open to every member (regular members need to know who the sect's allies are);
 *  forming (ally) and breaking (manage allies) alliances stay sect-leader only. Returns the x it
 *  stopped at, so the caller can reserve that space when centering the title cluster. Landscape
 *  only — see drawHeaderTitle's showIdentity gate (portrait keeps these in the body instead,
 *  via RenderPanel.renderFamilies' drawAllianceControlsRow). */
function drawHeaderAllianceButtons(
  core: SectSceneCore,
  rightEdge: number,
  headerH: number,
  add: <T extends PIXI.DisplayObject>(node: T) => T
): number {
  if (!core.sect) return rightEdge;
  const bh = Math.round(headerH * 0.4);
  const by = (headerH - bh) / 2;
  const padX = 14;
  let x = rightEdge;

  // Busy (a mutating action in flight) greys these out too — mainly to avoid the race of opening
  // a new ally/manage-ally modal while a previous ally/unally request is still pending.
  const busy = core.bt.busy;
  const addBtn = (label: string, color: number, action: () => void, seed: number): void => {
    const c = busy ? C.mid : color;
    // Measure the label off-tree first, then add the panel *before* the label so the label
    // paints on top of it — adding the opaque sketchPanel fill after the text hid the text
    // entirely (border-only button, still clickable since hit-testing doesn't care about z-order).
    const lbl = txt(label, FS.tiny, c);
    const bw = Math.ceil(lbl.width) + padX * 2;
    const bx = x - bw;
    const btn = add(sketchPanel(bw, bh, { fill: 0xf8f8f0, border: c, seed: seedFor(seed, 3, bw) }));
    btn.x = bx; btn.y = by;
    add(lbl);
    lbl.anchor.set(0.5, 0.5); lbl.x = bx + bw / 2; lbl.y = by + bh / 2;
    if (!busy) core.hitRects.push({ rect: { x: bx, y: by, w: bw, h: bh }, fn: action });
    x = bx - 8;
  };

  if (core.isSectLeader) {
    addBtn(t('sect.manageAllies'), C.dark, () => void core.allianceHooks.openManageAllies(), 2);
    addBtn(t('sect.ally'), C.accent, () => void core.allianceHooks.openAllyList(), 1);
  } else {
    addBtn(t('sect.allies', { n: core.sect.allySectIds.length }), C.accent, () => void core.allianceHooks.openAlliesView(), 1);
  }
  return x;
}
