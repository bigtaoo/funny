// header.ts — the roster/wardrobe title bar, split out of ./core.ts (2026-08-27) when the per-tab
// scroll memory pushed that file past the 500-line convention. Same seam EquipmentScene
// (./EquipmentScene/headerRow.ts) and FamilyScene/SectScene (their header.ts) already have: plain
// functions over the shared Core, not another class — the split-form priority order in
// claudedocs/client-modules.md prefers an independent function module.
//
// Nothing here holds state; the results land back on Core's fields (backRect/headerH/titleRight),
// which every body layout below the bar reads.
import { t } from '../../i18n';
import { ui as C, tearDownChildren } from '../../render/sketchUi';
import { drawSceneHeader, sceneHeaderHeight, headerCurrencyWidth, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { CARD_INV_CAP, CARD_INV_OVERFLOW_BUFFER } from '../../game/meta/cardDefs';
import type { CardSceneCore } from './core';

/** What the header's coin + capacity cluster reads out — see {@link headerCurrencySpec}. */
export interface HeaderCurrencySpec {
  coins: number;
  capacity?: { text: string; color: number };
  scale: number;
}

/**
 * Title bar for the tab that is on screen. Drawn per render(), not once in Core.build(): the header
 * used to be part of the one-shot layer scaffold, so switching to the wardrobe left "Hero Roster"
 * (and the roster glyph) sitting above a page of skins (2026-08-26). Same shape as FriendsScene's
 * drawHeader — title + glyph both keyed off the active tab.
 */
export function renderCardHeader(core: CardSceneCore): void {
  const { w, h } = core;
  tearDownChildren(core.headerLayer);
  const skins = core.tab === 'skins';
  // The title band has to know how wide the coin/capacity cluster ListPanel.renderHeaderCurrency()
  // draws on top of it: the old fixed 20%-of-width guess was ~7 points short of the real cluster on
  // a 430pt portrait viewport, so the centred "Hero Roster" ran straight under the coin number
  // (2026-08-24). Measured from the same spec the draw call uses.
  const spec = headerCurrencySpec(core);
  const hdr = drawSceneHeader(core.headerLayer, w, h, t(skins ? 'roster.tab.skins' : 'roster.title'), {
    variant: 'paper', accent: HEADER_ACCENT.spend, icon: skins ? 'skinIcon' : 'rosterIcon',
    rightReserve: headerCurrencyWidth(sceneHeaderHeight(h), spec.coins, [], spec.capacity, spec.scale),
  });
  core.backRect = hdr.backRect;
  core.headerH = hdr.headerH;
  core.titleRight = hdr.titleRight;
}

/**
 * Inputs for the header's coin + capacity cluster, in one place because two callers need the same
 * answer: renderCardHeader() measures it to size the title band, ListPanel.renderHeaderCurrency()
 * draws it. Splitting the expression between them is exactly how the reserve and the cluster
 * drift apart.
 *
 * The capacity readout counts CARDS, so it belongs to the roster grid only — on the wardrobe it
 * was a card count sitting over a page of skins (2026-08-26, same report as the stale title).
 */
export function headerCurrencySpec(core: CardSceneCore): HeaderCurrencySpec {
  const save = core.cb.getSave();
  const count = Object.keys(save.cardInv ?? {}).length;
  const warn = count >= CARD_INV_CAP - CARD_INV_OVERFLOW_BUFFER;
  const full = count >= CARD_INV_CAP;
  return {
    coins: save.wallet.coins,
    capacity: core.tab === 'skins' ? undefined : {
      text: t('roster.capacity').replace('{cur}', String(count)).replace('{cap}', String(CARD_INV_CAP)),
      color: full ? C.red : warn ? C.gold : C.mid,
    },
    // Keep the readout at a compact absolute size (matches EquipmentScene, its [Cards|Equipment]
    // peer) rather than scaling it up with the taller unified header.
    scale: 100 / sceneHeaderHeight(core.h),
  };
}
