// WorldMapInput's two friendly-tile menus: the owned tile (reinforce / move / garrison / build /
// relocate / abandon, or straight into the city when the tap lands anywhere on the 3x3 capital) and the
// ally tile (garrison or recall, never attack). Pulled out of WorldMapInput
// (claudedocs/client-modules.md "单文件 500 行收敛" — the 2026-09-12 siege-round work pushed that file to
// 502) as an independent-function module (form①, same shape as ./cityPanel.ts, ./headerButtons.ts and
// ./tileInfoLines.ts): both branches only read ctx's caches and call through to ctx.net / ctx.panels /
// ctx.cb, so they are free functions taking `ctx`. Bodies are verbatim, with `this.ctx` becoming `ctx`.
import { t } from '../../../i18n';
import { baseFootprintCells, baseFootprintInBounds } from '@nw/shared';
import { coordLine, type ModalLine, type ModalButton } from '../WorldMapPanels/modalLine';
import { resLevelLine, baseLevelLine, structureLine } from './tileInfoLines';
import type { PlayerWorldView, WorldTileView } from '../../../net/WorldApiClient';
import type { WorldMapContext } from '../WorldMapContext';

/**
 * Mirrors worldsvc's footprintOwnedBy (§3.4): true iff the whole 3×3 block anchored at (ax,ay) is owned by
 * the player right now — in bounds and every cell cached as `mine`. This is the relocate gate: the capital
 * may only move onto a 3×3 the player already fully holds, so a cell that is neutral, enemy, or not yet
 * revealed (uncached → not provably mine) disqualifies the block. The server re-validates on relocate.
 */
function footprintAllMine(ctx: WorldMapContext, ax: number, ay: number): boolean {
  if (!baseFootprintInBounds(ax, ay, ctx.mapW, ctx.mapH)) return false;
  for (const { x, y } of baseFootprintCells(ax, ay)) {
    if (!ctx.tileCache.get(`${x}:${y}`)?.mine) return false;
  }
  return true;
}

/** Menu for a tile the player already owns — or, on any of the capital's nine cells, no menu at all. */
export function showMineTileMenu(
  ctx: WorldMapContext,
  tile: WorldTileView,
  tx: number,
  ty: number,
  me: PlayerWorldView,
): void {
  // My tile — reinforce (march from base) + abandon. Base itself: no actions.
  const [bx, by] = me.mainBaseTile ? ctx.parseTileId(me.mainBaseTile) : [-1, -1];
  // The base is an indivisible 3×3 block (ADR-025) — any cell inside its footprint counts as
  // "the city", not just the exact center anchor tile, otherwise 8 of the 9 tiles fell through
  // to the generic mine-tile menu (no Enter City / Train option) and looked like a dead click.
  const isBase = me.mainBaseTile != null && baseFootprintCells(bx, by).some((c) => c.x === tx && c.y === ty);
  if (isBase) {
    // Main city — no menu: tapping the base goes straight into the desk (city) scene.
    // Defense is not a manual setting here — teams left in the city auto-defend (ADR-026 §2);
    // teams that are out on a march simply leave the base undefended.
    // SLG opening guide chain step1 (ONBOARDING_DESIGN §4.2): tapping the highlighted base is
    // exactly the completion condition — mark it seen before handing off to CityScene.
    if (ctx.guideStep === 'step1') {
      ctx.cb.setFlag?.('guide.world.step1', true);
      ctx.guideStep = null;
    }
    ctx.cb.onOpenCity();
    return;
  }
  const tileKey = `${ctx.cb.worldId}:${tx}:${ty}`;
  // Only MY stationed team here can be recalled — ctx.stationed now also carries enemy teams (P4), whose
  // teamId is blanked; matching one would send an un-actionable recall.
  const stationedHere = ctx.stationed.find((s) => s.mine !== false && s.x === tx && s.y === ty);
  const myButtons: ModalButton[] = [
    { label: t('world.actReinforce'), action: () => ctx.panels.showDeployDialog(tx, ty, 'reinforce'), icon: 'swords' },
    // Move (2026-07-23): park a home team on this tile. ADR-051 (P4) two intents — 移动到此(停留 idle, free to
    // re-command) vs 移动并驻扎 (garrison, defends its 3×3 footprint + intercepts passers, stays busy). Recall
    // sends a team already stationed here back home. One stationed team per tile → offer Move/Garrison only
    // when none of mine stands here.
    ...(stationedHere
      ? [{ label: t('world.actRecallStation'), action: () => void ctx.net.doRecallStationed(stationedHere.teamId), icon: 'home' as const }]
      : [
          // The 停留/驻扎 pair, told apart by movement-vs-presence: footprints for a team that
          // just walks there and stays free to re-command, a pitched tent for one that digs in.
          // Both were borrowing something else until batch 9 (`spd`'s chevrons and `unit`'s
          // helmet); the helmet stays two lines further down, where it means "troops present".
          { label: t('world.actMove'), action: () => void ctx.net.showTeamPicker(tx, ty, 'move', 'idle'), icon: 'footsteps' as const },
          { label: t('world.actGarrison'), action: () => void ctx.net.showTeamPicker(tx, ty, 'move', 'garrison'), icon: 'camp' as const },
        ]),
    { label: t('world.actDefense'), action: () => { ctx.panels.closeModal(); ctx.cb.onOpenDefense(tileKey); }, icon: 'defenseTabIcon' },
  ];
  // Watchtower (§18 G5 V2): build a long-radius persistent vision source on an owned tile. If a tower already exists, show a status line instead of the build button.
  if (!tile.watchtower) {
    myButtons.push({ label: t('world.actWatchtower'), action: () => ctx.net.confirmWatchtower(tx, ty), icon: 'watchtower' });
  }
  // ADR-051 (P5): player structures — one per tile. Build an arrow tower (chips passing enemies over 9 cells)
  // or a blocker (forces enemy detours) on own territory; demolish one's own structure. (Not offered on the
  // base anchor — that branch returns above.)
  if (tile.structure) {
    myButtons.push({ label: t('world.actDemolish'), action: () => void ctx.net.doDemolishStructure(tx, ty), icon: 'hammer' });
  } else {
    // These two plus the watchtower above can all be in this menu at once, which is why their
    // art was drawn as one set and reviewed side by side at 26px (batch 9): a wide open trestle,
    // a narrow closed shaft with an arrow, a low spiked lattice. `hammer` -- which all three
    // shared while they had no art -- stays on demolish, where "this is construction work" is
    // the whole message.
    myButtons.push({ label: t('world.actArrowTower'), action: () => ctx.net.confirmBuildStructure(tx, ty, 'arrowTower'), icon: 'arrowTower' });
    myButtons.push({ label: t('world.actBlocker'), action: () => ctx.net.confirmBuildStructure(tx, ty, 'blocker'), icon: 'blocker' });
  }
  // Relocate here (§3.4): the capital may only move onto a 3×3 block the player already fully owns —
  // this clicked cell as centre plus all 8 neighbours. Only offered once that ring is fully mine
  // (unsupported options are omitted outright rather than shown disabled, 2026-08-02).
  if (me.mainBaseTile && footprintAllMine(ctx, tx, ty)) {
    myButtons.push({ label: t('world.actRelocate'), action: () => ctx.net.confirmRelocate(tx, ty), icon: 'castle' });
  }
  myButtons.push({ label: t('world.actAbandon'), action: () => ctx.net.doAbandon(tx, ty), icon: 'scrap' });
  myButtons.push({ label: t('common.close'), action: () => ctx.panels.closeModal(), icon: 'close' });
  const head: ModalLine[] = [{ text: t('world.mine'), icon: 'flag' }];
  if (tile.watchtower) head.push({ text: t('world.hasWatchtower'), icon: 'watchtower' });
  if (tile.structure) head.push(structureLine(tile.structure.kind));
  head.push(coordLine(tx, ty));
  const mineBaseLine = baseLevelLine(tile);
  if (mineBaseLine) head.push(mineBaseLine);
  const mineResLine = resLevelLine(tile);
  if (mineResLine) head.push(mineResLine);
  ctx.panels.showModal(head, myButtons);
  return;
}

/** Menu for family / sect-mate / allied-sect land: help defend it, or take a team back. */
export function showAllyTileMenu(ctx: WorldMapContext, tile: WorldTileView, tx: number, ty: number): void {
  // Ally territory (family §8.2, a fellow sect member outside the family, or an allied-sect member):
  // friendly land — cannot be attacked (server rejects with ALLY_TILE) or occupied. Sect-mate added
  // 2026-08-08: this branch must mirror `friendlyAccountIds` (self+family+own sect+allied sects) exactly,
  // or the client offers Attack on land the server will reject. Per the 驻守 rule (2026-08-02) a team MAY
  // still be sent to Garrison (驻扎) here to help defend it — same friendlyAccountIds set the server uses to block siege.
  // 停留 idle has no defensive claim and stays own/neutral-tile-only, so it isn't offered here. Unsupported
  // options are omitted outright rather than shown disabled.
  const ownerLine = tile.ownerName
    ? `${tile.ownerName}${tile.ownerPublicId ? ' #' + tile.ownerPublicId : ''}`
    : (tile.ownerPublicId ? '#' + tile.ownerPublicId : t('world.unknownOwner'));
  const allyButtons: ModalButton[] = [];
  const stationedAlly = ctx.stationed.find((s) => s.mine !== false && s.x === tx && s.y === ty);
  if (stationedAlly) {
    allyButtons.push({ label: t('world.actRecallStation'), action: () => void ctx.net.doRecallStationed(stationedAlly.teamId), icon: 'home' });
  } else {
    allyButtons.push({ label: t('world.actGarrison'), action: () => void ctx.net.showTeamPicker(tx, ty, 'move', 'garrison'), icon: 'camp' });
  }
  allyButtons.push({ label: t('common.close'), action: () => ctx.panels.closeModal(), icon: 'close' });
  const allyHead: ModalLine[] = [
    { text: t('world.allyTile'), icon: 'flag' },
    { text: ownerLine, icon: 'avatarTabIcon' },
    coordLine(tx, ty),
  ];
  if (tile.structure) allyHead.push(structureLine(tile.structure.kind));
  if (tile.maxHp && tile.hp != null) allyHead.push({ text: t('world.buildingHp').replace('{hp}', String(tile.hp)).replace('{max}', String(tile.maxHp)), icon: 'hp' });
  const allyBaseLine = baseLevelLine(tile);
  if (allyBaseLine) allyHead.push(allyBaseLine);
  const allyResLine = resLevelLine(tile);
  if (allyResLine) allyHead.push(allyResLine);
  ctx.panels.showModal(allyHead, allyButtons);
  return;
}
