// Header title row — split out of core.ts (2026-08-11, form ① independent function module per
// claudedocs/client-modules.md's split-form priority note) purely to keep core.ts under the
// 500-line convention. Only ever called from Core's own renderHeader(), so this takes `core`
// explicitly instead of becoming its own domain class.
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import { ui as C, txt } from '../../render/sketchUi';
import { buildIcon } from '../../render/icons';
import { buildEmblemIcon, type EmblemKey } from '../../render/emblemIcon';
import { buildTitleIcon, backPillRightEdge } from '../../ui/widgets/SceneHeader';
import { FS } from '../../render/fontScale';
import { FAMILY_CAP } from '@nw/shared';
import type { FamilySceneCore } from './core';

/** Muted secondary ink (a step below C.dark, still legible on paper) — matches RenderPanel's MUTED. */
const MUTED = 0x5a574f;

/** Header title row. Always shows the "Family" title just right of the back pill. In landscape
 *  (where there's horizontal room) it also carries the family identity the info band used to hold:
 *  `[TAG] Name` + prosperity on the left, member count pinned far-right. Portrait keeps that identity
 *  in the info band below the header, since the narrow bar can't hold it all on one line. */
export function drawHeaderTitle(core: FamilySceneCore, headerH: number): void {
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

  const showIdentity = core.landscape && core.family && core.mode === 'myFamily';
  const gap = Math.round(w * 0.02);
  const fam = showIdentity ? core.family! : null;

  // Build every node up front (unpositioned) so we can measure the whole cluster's width and
  // center it in the space between the back pill and the member count, instead of it always
  // starting flush against the back button — which read lopsided once the identity was moved
  // into the landscape header.
  // Batch-5 title glyph (three-person cluster), laid out as the same [icon][gap][title] group
  // `drawSceneHeader` builds — this scene passes `title: null` and owns the layout, so it positions
  // the group itself but takes `size`/`gap`/the ink rule from the shared builder.
  const titleIcon = buildTitleIcon('familyTabIcon', FS.headline, C.dark);
  add(titleIcon.node);
  const titleNode = add(txt(t('family.title'), FS.headline, C.dark, true));
  let clusterW = titleIcon.size + titleIcon.gap + titleNode.width;

  // Emblem badge (family-emblem-art-prompts.md, 2026-08-14): tinted with the family's chosen accent
  // colour, or a dashed placeholder circle inviting the leader to pick one — absent entirely for
  // non-leaders with no badge yet (nothing to tap, nothing worth showing).
  let emblemNode: PIXI.DisplayObject | null = null;
  const emblemSize = Math.round(h * 0.034);
  const isLeader = core.isFamilyLeader;
  if (fam) {
    const key = fam.emblemKey as EmblemKey | undefined;
    emblemNode = key ? buildEmblemIcon(key, emblemSize, fam.emblemColor ?? C.dark) : null;
    if (!emblemNode && isLeader) {
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
  let star: PIXI.DisplayObject | null = null;
  let starSize = 0;
  let prosNode: PIXI.Text | null = null;
  let countNode: PIXI.Text | null = null;
  if (fam) {
    nameNode = add(txt(`[${fam.tag}] ${fam.name}`, FS.title, C.dark));
    starSize = Math.round(h * 0.026);
    star = add(buildIcon('star', starSize, 0xd4a030));
    prosNode = add(txt(t('family.prosperity', { n: fam.prosperity }), FS.heading, 0xa9750f));
    countNode = add(txt(t('family.memberCount', { n: fam.memberCount, cap: FAMILY_CAP }), FS.heading, MUTED));
    clusterW += gap + nameNode.width + gap + starSize + 6 + prosNode.width;
  }

  const rightBound = countNode ? w - 16 - countNode.width - gap : w - 16;
  const available = rightBound - leftBound;
  let x = leftBound + Math.max(0, (available - clusterW) / 2);

  titleIcon.node.x = x; titleIcon.node.y = Math.round(midY - titleIcon.size / 2);
  x += titleIcon.size + titleIcon.gap;
  titleNode.anchor.set(0, 0.5); titleNode.x = x; titleNode.y = midY;
  x += titleNode.width;

  if (fam && nameNode && star && prosNode && countNode) {
    x += gap;
    if (emblemNode) {
      emblemNode.x = x; emblemNode.y = midY - emblemSize / 2;
      if (isLeader) core.hitRects.push({ rect: { x, y: midY - emblemSize / 2, w: emblemSize, h: emblemSize }, action: () => core.openEmblemPicker() });
      x += emblemSize + 8;
    }
    nameNode.anchor.set(0, 0.5); nameNode.x = x; nameNode.y = midY;
    x += nameNode.width + gap;

    star.x = x; star.y = midY - starSize / 2;
    x += starSize + 6;
    prosNode.anchor.set(0, 0.5); prosNode.x = x; prosNode.y = midY;

    countNode.anchor.set(1, 0.5); countNode.x = w - 16; countNode.y = midY;
  }
}
