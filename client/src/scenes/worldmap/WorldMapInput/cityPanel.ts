// WorldMapInput's wild-city info + siege panel (ADR-074 P1). Pulled out of WorldMapInput
// (claudedocs/client-modules.md "单文件 500 行收敛") — independent-function-module extraction (form①,
// same shape as ./headerButtons.ts): the panel only reads ctx's city-node list / me / panels and calls
// through to ctx.net, so it is a free function taking `ctx` plus the one piece of state it owns
// (which city's panel is showing, so a late refresh cannot resurrect a dismissed panel).
import { t } from '../../../i18n';
import { cityNodeCovering } from '@nw/shared';
import { formatDuration } from '../logic/formatDuration';
import { coordLine, type ModalLine, type ModalButton } from '../WorldMapPanels/modalLine';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * Tile whose city panel is currently showing, or null. Owned by WorldMapInput and passed in, because it
 * has to survive across the two showCityPanel calls one tap makes (cached draw, then post-refresh redraw).
 */
export interface CityPanelState {
  openAt: { x: number; y: number } | null;
}

/**
 * Wild-city info + siege panel (ADR-074 P1). Reads the city's live siege state from `ctx.cityNodes`
 * (the `POST /world/enter` payload, refreshed by WorldMapNet) rather than from the clicked TILE: the plot
 * is indivisible, so the entity is the CITY, and the tile only tells us which plot was tapped.
 *
 * The siege button is offered only when every precondition the server checks is already satisfied —
 * sect membership, no active post-capture protection, not already ours. Same convention as the
 * occupy button on neutral land (2026-08-02): a precondition that cannot be met hides the button rather
 * than showing it disabled, so the panel never invites a march the server will reject.
 */
export function showCityPanel(
  ctx: WorldMapContext,
  state: CityPanelState,
  tx: number,
  ty: number,
  tileLevel?: number,
  refreshed = false,
): void {
  // Durability regenerates continuously and rival sects are hitting the same walls, so the entry-payload
  // snapshot is stale within minutes. Draw immediately from cache (so the panel never blocks on the
  // network), then refresh once and redraw — guarded by `refreshed` so the redraw cannot loop, and by
  // `cityPanelOpenAt` so a panel the player has already closed (or replaced by tapping elsewhere) is not
  // resurrected by a response that lands late.
  if (!refreshed) {
    state.openAt = { x: tx, y: ty };
    void ctx.net.refreshCities().then(() => {
      if (state.openAt?.x === tx && state.openAt?.y === ty) showCityPanel(ctx, state, tx, ty, tileLevel, true);
    });
  }
  const city = cityNodeCovering(ctx.cityNodes ?? [], tx, ty);
  const lines: ModalLine[] = [{ text: t('world.city'), icon: 'castle' }, coordLine(tx, ty)];
  const level = city?.level ?? tileLevel;
  if (level != null) lines.push({ text: t('world.cityLevel').replace('{lv}', String(level)), icon: 'star' });

  if (!city) {
    // No node state (entry payload not landed yet, or a world opened before P1 and never reset) — show
    // what the tile knows and nothing more, rather than a siege button that would 400 on departure.
    lines.push({ text: t('world.cityHint'), icon: 'book' });
    ctx.panels.showModal(lines, [{ label: t('common.close'), action: () => { state.openAt = null; ctx.panels.closeModal(); }, icon: 'close' }]);
    return;
  }

  const mySect = ctx.me?.sectId;
  const owned = !!city.ownerSectId;
  const mine = owned && city.ownerSectId === mySect;
  lines.push(owned
    ? { text: t(mine ? 'world.cityOwnedByUs' : 'world.cityOwnedBy').replace('{sect}', city.ownerSectName ?? city.ownerSectId ?? ''), icon: 'sectTabIcon' }
    : { text: t('world.cityUnclaimed'), icon: 'flag' });

  // Durability as an ABSOLUTE pair, not just a bar: the curve is base-dominated (26,000 + 900/level, see
  // SLG_CITY_SIEGE_DESIGN §6.5), so a level-3 city and a level-10 capital are within ~22% of each other
  // and a percentage-only readout looks like a bug. The regen line is the part that explains the whole
  // design — it is why one player can never finish this alone.
  if (city.durabilityMax != null && city.durability != null) {
    lines.push({
      text: t('world.cityDurability')
        .replace('{cur}', String(Math.round(city.durability)))
        .replace('{max}', String(city.durabilityMax)),
      icon: 'hp',
    });
    if (city.regenPerHour) lines.push({ text: t('world.cityRegen').replace('{n}', String(city.regenPerHour)), icon: 'hourglassSm' });
  }

  const protectedFor = (city.protectedUntil ?? 0) - Date.now();
  if (protectedFor > 0) lines.push({ text: t('world.cityProtected').replace('{d}', formatDuration(Math.ceil(protectedFor / 1000))), icon: 'lock' });

  // Per-sect contribution this siege round (§7). Ownership goes to the LAST hit, not the largest
  // contributor — this list is here so a sect can see whether it is actually the one doing the work.
  const log = city.siegeLog;
  if (log) {
    const top = Object.entries(log).sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [sectId, dmg] of top) {
      lines.push({
        text: t('world.citySiegeLog')
          .replace('{sect}', sectId === mySect ? t('world.citySiegeLogUs') : sectId)
          .replace('{n}', String(Math.round(dmg))),
        icon: 'atk',
      });
    }
  }

  const buttons: ModalButton[] = [];
  if (!mySect) {
    lines.push({ text: t('world.cityNeedSect'), icon: 'lock' });
  } else if (mine) {
    lines.push({ text: t('world.cityOursHint'), icon: 'check' });
  } else if (protectedFor > 0) {
    // Protection line already shown above; no button.
  } else {
    buttons.push({ label: t('world.actSiegeCity'), action: () => void ctx.net.showTeamPicker(tx, ty, 'attack'), icon: 'siege' });
  }
  buttons.push({ label: t('common.close'), action: () => { state.openAt = null; ctx.panels.closeModal(); }, icon: 'close' });
  ctx.panels.showModal(lines, buttons);
}
