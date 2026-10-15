// The level prep page's one-line info rows under the objective banner: the clear rewards preview and
// the NEW-card row (ONBOARDING_DESIGN §17.2). Same panel family, one accent colour each. Split out of
// LevelPrepScene.ts for the 500-line rule (claudedocs/client-modules.md).
import * as PIXI from 'pixi.js-legacy';
import { t } from '../../i18n';
import type { LevelRewards } from '@nw/engine/campaign/LevelDefinition';
import { ui as C, txt, sketchPanel, sketchAccentBar, seedFor, marginLineX } from '../../render/sketchUi';
import { buildIcon, type IconKind } from '../../render/icons';
import { buildMaterialIcon, type MaterialKind } from '../../render/atlas/materialAtlas';
import { FS } from '../../render/fontScale';

interface Row { padX: number; panW: number; panH: number; fs: number; label: PIXI.Text }

/** Panel + accent bar + leading label at `y`; the caller lays its content out after `label`. */
function openRow(parent: PIXI.Container, w: number, h: number, y: number, accent: number, seed: [number, number], label: PIXI.Text): Row {
  const padX = marginLineX(w);
  const panW = w - padX - Math.round(w * 0.06);
  const fs = FS.headline;
  const panH = fs * 1.6 + Math.round(h * 0.021) * 2;
  const bg = sketchPanel(panW, panH, { fill: C.paper, border: C.line, width: 1.2, seed: seedFor(padX, y + seed[0], panW) });
  bg.x = padX; bg.y = y;
  sketchAccentBar(bg, panH, accent, seedFor(padX, panH, seed[1]));
  parent.addChild(bg);
  label.anchor.set(0, 0.5);
  label.x = padX + Math.round(panW * 0.06);
  label.y = y + panH / 2;
  parent.addChild(label);
  return { padX, panW, panH, fs, label };
}

/** Reward preview row (coins + materials) — fills the otherwise-empty mid page. Returns the next y. */
export function drawRewardsRow(parent: PIXI.Container, w: number, h: number, rewards: LevelRewards, y: number): number {
  const { panH, fs, label } = openRow(parent, w, h, y, C.green, [2, 11], txt(t('level.rewards.label'), FS.headline, C.mid));
  let cx = label.x + label.width + Math.round(w * 0.03);
  const iconSize = Math.round(panH * 0.56);
  const entries: Array<{ icon: IconKind; count: number }> = [];
  if (rewards.coins) entries.push({ icon: 'coin', count: rewards.coins });
  for (const [id, count] of Object.entries(rewards.materials ?? {})) {
    if (count > 0 && (id === 'scrap' || id === 'lead' || id === 'binding')) entries.push({ icon: id, count });
  }
  for (const entry of entries) {
    const icon = entry.icon === 'coin'
      ? buildIcon(entry.icon, iconSize, C.dark)
      : buildMaterialIcon(entry.icon as MaterialKind, iconSize, C.dark);
    icon.x = cx; icon.y = y + (panH - iconSize) / 2;
    parent.addChild(icon);
    cx += iconSize + Math.round(w * 0.01);
    const cnt = txt(`×${entry.count}`, fs, C.dark, true);
    cnt.anchor.set(0, 0.5);
    cnt.x = cx; cnt.y = y + panH / 2;
    parent.addChild(cnt);
    cx += cnt.width + Math.round(w * 0.03);
  }
  return y + panH + Math.round(h * 0.01);
}

/** "NEW" tag + the names of the cards this level introduces (§17.2). Returns the next y. */
export function drawNewCardsRow(parent: PIXI.Container, w: number, h: number, names: string[], y: number): number {
  const { padX, panW, panH, fs, label } = openRow(parent, w, h, y, C.red, [3, 17], txt(t('level.newCard.tag'), FS.headline, C.red, true));
  const list = txt(names.join(t('level.newCard.sep')), fs, C.dark, true);
  list.anchor.set(0, 0.5);
  list.x = label.x + label.width + Math.round(w * 0.03);
  list.y = y + panH / 2;
  const room = padX + panW - Math.round(panW * 0.04) - list.x;
  if (list.width > room) list.scale.set(room / list.width);
  parent.addChild(list);
  return y + panH + Math.round(h * 0.01);
}
