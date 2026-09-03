// WorldMapInput's per-tile info lines: the resource/level line and the base-level line that replaces
// it on a capital. Pulled out of WorldMapInput (claudedocs/client-modules.md "单文件 500 行收敛" — the
// modal-glyph pass pushed that file to 507) as an independent-function module (form①, same shape as
// ./cityPanel.ts and ./headerButtons.ts): both are pure functions of one `WorldTileView`, with no
// reference to `ctx` at all.
import { t } from '../../../i18n';
import type { WorldTileView } from '../../../net/WorldApiClient';
import type { ModalLine } from '../WorldMapPanels/modalLine';

/**
 * Resource type + level line for a tile's info modal, e.g. "Paper Lv3" (§ resourceDensity=1.0 —
 * nearly every tile carries a resType, whether neutral or already captured). Previously only the
 * neutral fallthrough branch of onTileClick showed this — the mine/ally/enemy branches all `return`
 * before reaching it, so a captured tile's resource type was invisible in its info panel even though
 * the server always sends `resType` regardless of ownership (2026-08-09 fix, see tileGraphics.ts's
 * motifResType for the matching map-icon fix). Returns null when the tile carries no resType.
 *
 * A main base is the one exception, and the reason is not cosmetic: tileYield() (@nw/shared
 * slg/march.ts) short-circuits on `type === 'base'` and pays a flat ink rate, ignoring resType and
 * level entirely. Printing "Metal Lv.3" on a capital therefore advertises production that does not
 * exist, and the level shown is the buried resource TILE's — unrelated to the base's own level, and
 * unrelated to the durability line right above it, which comes from the owner's WALL level
 * (2026-09-02 user report). {@link baseLevelLine} takes its place there.
 */
export function resLevelLine(tile: WorldTileView): ModalLine | null {
  if (!tile.resType) return null;
  if (tile.type === 'base') return null;
  const RES_LABEL: Record<string, string> = {
    ink: t('world.ink'), paper: t('world.paper'), graphite: t('world.graphite'),
    metal: t('world.metal'), sticker: t('world.sticker'),
  };
  return {
    text: t('world.resLevel').replace('{res}', RES_LABEL[tile.resType] ?? tile.resType).replace('{lv}', String(tile.level ?? 1)),
    icon: { res: tile.resType },
  };
}

/**
 * The base-level line that replaces the (suppressed) resource line on a capital — the one level that
 * IS meaningful there. `deskLevel` is mirrored onto the base ANCHOR only, and only once a desk
 * upgrade has completed, so its presence doubles as the anchor/ring discriminator: the 8 ring cells
 * of the 3×3 footprint never carry it and correctly show no level at all, rather than the `level: 1`
 * placeholder their TileDocs are seeded with (see worldsvc core/spawn.ts baseTileDocs).
 */
export function baseLevelLine(tile: WorldTileView): ModalLine | null {
  if (tile.type !== 'base' || tile.deskLevel == null) return null;
  return { text: t('world.baseLevel').replace('{lv}', String(tile.deskLevel)), icon: 'desk' };
}

/**
 * The "there is a structure on this tile" line. One function rather than the ternary it replaces,
 * because that ternary was written out at all three ownership branches (mine/ally/enemy) — three
 * copies of a two-way mapping that now has to agree on an icon as well as a string, i.e. three
 * chances to drift.
 *
 * Until batch 9 these lines carried an EMOJI inside the localised string (🏹/🚧) because no ink art
 * existed: dropping it early would have left the line with no marker at all, and an emoji renders in
 * the system font rather than the game's hand-drawn ink — on WeChat/iOS not even the same glyph
 * twice. The strings lost their emoji in the same edit that gave these two an `icon:`.
 */
export function structureLine(kind: 'arrowTower' | 'blocker'): ModalLine {
  return kind === 'arrowTower'
    ? { text: t('world.hasArrowTower'), icon: 'arrowTower' }
    : { text: t('world.hasBlocker'), icon: 'blocker' };
}
