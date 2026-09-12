import { t } from '../../i18n';
import { npcGarrison } from '@nw/shared';
import { HUD_H } from './logic/constants';
import { hitTestHeaderButtons } from './WorldMapInput/headerButtons';
import { showCityPanel, type CityPanelState } from './WorldMapInput/cityPanel';
import { showAllyTileMenu, showMineTileMenu } from './WorldMapInput/friendlyTileMenus';
import { siegeHoldAt } from './logic/siegeHold';
import { formatDuration } from './logic/formatDuration';
import { serverNow } from '../../net/serverClock';
import { coordLine, type ModalLine, type ModalButton } from './WorldMapPanels/modalLine';
import { resLevelLine, baseLevelLine, structureLine } from './WorldMapInput/tileInfoLines';
import { territoryConnected } from './logic/attackConnectivity';
import type { WorldMapContext } from './WorldMapContext';
import { dispatchHit, hitAction, inRect, runHit, type Hit } from '../../ui/hits';

export class WorldMapInput {
  /** State owned by the extracted city-siege panel (see ./WorldMapInput/cityPanel.ts). */
  private readonly cityPanel: CityPanelState = { openAt: null };

  constructor(private readonly ctx: WorldMapContext) {}

  /**
   * ADR-039 "连地" pre-check for a single occupy target — used only to grey out (omit) the Occupy button
   * so it's not a click-then-reject; the server re-validates on departure regardless. Thin wrapper over
   * the shared connectivity check (./logic/attackConnectivity.ts), which the attack/siege path also uses.
   */
  private occupyConnected(tx: number, ty: number): boolean {
    return territoryConnected(this.ctx, [{ x: tx, y: ty }]);
  }

  onTileClick(tx: number, ty: number): void {
    if (tx < 0 || ty < 0 || tx >= this.ctx.mapW || ty >= this.ctx.mapH) return;
    this.ctx.selectedTile = { x: tx, y: ty };
    this.ctx.view.renderMap();

    const tile = this.ctx.tileCache.get(`${tx}:${ty}`);
    const me = this.ctx.me;

    if (!me?.joined) {
      // Not yet placed (normally auto-placed on map entry; this is the manual-retry path for the world-full / no-slot fallback).
      // The system picks the location automatically; the tap coordinate is no longer used for placement.
      this.ctx.panels.showModal(
        [
          { text: t('world.joinTitle'), icon: 'globe' },
          { text: t('world.confirmJoin'), icon: 'book' },
        ],
        [
          { label: t('world.confirmJoinBtn'), action: () => void this.ctx.net.doJoin(), icon: 'play' },
          { label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' },
        ],
      );
      return;
    }

    if (tile?.mine) {
      showMineTileMenu(this.ctx, tile, tx, ty, me);
      return;
    }

    if (tile?.ally || tile?.sectmate || tile?.allySect) {
      showAllyTileMenu(this.ctx, tile, tx, ty);
      return;
    }

    if (tile?.occupied) {
      // Enemy tile — siege (attack march from base). Protected tiles can't be hit.
      const ownerLine = tile.ownerName
        ? `${tile.ownerName}${tile.ownerPublicId ? ' #' + tile.ownerPublicId : ''}`
        : (tile.ownerPublicId ? '#' + tile.ownerPublicId : t('world.unknownOwner'));
      const buttons: ModalButton[] = [];
      const protectedNow = (tile.protectedUntil ?? 0) > Date.now();
      if (!protectedNow) {
        buttons.push({ label: t('world.actAttack'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'attack'), icon: 'siege' });
      }
      // 停止围攻 (2026-09-12, user decision: stoppable from the team panel AND from the tile the team is
      // standing on). Offered alongside Attack rather than instead of it — a second team can still be
      // sent in while the first is mid-round.
      const siegeHere = siegeHoldAt(this.ctx, tx, ty);
      if (siegeHere?.teamId) {
        const stopTeamId = siegeHere.teamId;
        buttons.push({ label: t('world.actStopSiege'), action: () => void this.ctx.net.doStopHold(stopTeamId, 'siege'), icon: 'home' });
      }
      buttons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
      const enemyHead: ModalLine[] = [
        { text: t('world.enemyTile'), icon: 'flag' },
        { text: ownerLine, icon: 'avatarTabIcon' },
        coordLine(tx, ty),
      ];
      // Say what the stop button would be stopping, with the same countdown the team row shows.
      if (siegeHere) {
        enemyHead.push({
          text: t('world.team.besieging').replace('{time}', formatDuration((siegeHere.dueAt - serverNow()) / 1000)),
          icon: 'hourglassMd',
        });
      }
      // ADR-051 (P5): flag an enemy structure so the player knows attacking this tile razes it.
      if (tile.structure) enemyHead.push(structureLine(tile.structure.kind));
      if (tile.maxHp && tile.hp != null) enemyHead.push({ text: t('world.buildingHp').replace('{hp}', String(tile.hp)).replace('{max}', String(tile.maxHp)), icon: 'hp' });
      const enemyBaseLine = baseLevelLine(tile);
      if (enemyBaseLine) enemyHead.push(enemyBaseLine);
      const enemyResLine = resLevelLine(tile);
      if (enemyResLine) enemyHead.push(enemyResLine);
      this.ctx.panels.showModal(enemyHead, buttons);
      return;
    }

    // Mid occupation-hold (ADR-037 §5.4, widened 2026-08-09 — every capture in the game now goes
    // through this, not just neutral-land occupy: PvP territory/crossing attacks, PvE
    // stronghold/crossing captures): the tile has no owner yet, but SOME pending claimant has already
    // won the battle and is waiting out the hold countdown before ownership lands. Checked before the
    // 'stronghold' branch below — a contested stronghold still carries `type:'stronghold'` throughout
    // the hold (see writeContestedHold), so without this ordering a stronghold mid-hold would
    // wrongly show "attack the NPC garrison" instead of "occupying, Xs left" / the expulsion offer.
    if (tile?.contestedUntil) {
      const secLeft = Math.max(0, Math.ceil((tile.contestedUntil - Date.now()) / 1000));
      if (tile.contestedByMe) {
        // My own pending hold. No reinforcement in v1, but since 2026-09-12 it can be called off from
        // here as well as from the team panel — the user's rule for both kinds of hold.
        const holdHere = this.ctx.occupations.find((o) => o.x === tx && o.y === ty);
        const holdButtons: ModalButton[] = [];
        if (holdHere?.teamId) {
          const stopTeamId = holdHere.teamId;
          holdButtons.push({ label: t('world.actStopOccupy'), action: () => void this.ctx.net.doStopHold(stopTeamId, 'occupy'), icon: 'home' });
        }
        holdButtons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
        this.ctx.panels.showModal([
          { text: t('world.occupyingMine').replace('{sec}', String(secLeft)), icon: 'hourglassMd' },
          coordLine(tx, ty),
        ], holdButtons);
        return;
      }
      // Someone else is holding it — offer an expelling attack instead of occupy/sweep (occupying it directly
      // would just bounce off the pending holder's contestedBy at arrival; use attack to fight their held garrison).
      const holdButtons: ModalButton[] = [
        { label: t('world.actAttack'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'attack'), icon: 'siege' },
        { label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' },
      ];
      this.ctx.panels.showModal([
        { text: t('world.occupying').replace('{sec}', String(secLeft)), icon: 'hourglassMd' },
        coordLine(tx, ty),
      ], holdButtons);
      return;
    }

    if (tile?.type === 'center') {
      this.ctx.panels.showToast(t('world.center'));
      return;
    }

    // Wild city (ADR-074): a city's whole footprint is `familyKeep` city ground — indivisible, siege-only,
    // and gated on sect membership. Before ADR-074 only the anchor cell carried this type and nothing on
    // either side rejected it, so clicking inside a city's walls fell through to the neutral branch below
    // and offered a plain 占领 against the underlying resource tile's NPC garrison (用户 2026-08-25 截图:
    // 「墨水 · Lv.2 · 建议兵力 240」 on a Lv.8 city).
    if (tile?.type === 'familyKeep') {
      showCityPanel(this.ctx, this.cityPanel, tx, ty, tile.level ?? undefined);
      return;
    }

    // Stronghold (G8 §3.1): while unoccupied it is an ultra-strong NPC garrison — cannot be directly occupied or swept, only besieged (march with a team). Once captured it becomes a territory tile handled by the mine/occupied branches above.
    if (tile?.type === 'stronghold') {
      this.ctx.panels.showModal(
        [
          { text: t('world.stronghold'), icon: 'stronghold' },
          { text: t('world.strongholdHint'), icon: 'book' },
          coordLine(tx, ty),
        ],
        [
          { label: t('world.actAttack'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'attack'), icon: 'siege' },
          { label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' },
        ],
      );
      return;
    }

    // Neutral tile. NPC garrison present → offer sweep (march). Occupy is now a march (ADR-037 §5.4: fights the
    // tile's system garrison via the deterministic engine, then holds it for a countdown before ownership lands)
    // — same troop-count dialog as sweep/reinforce, not an instant grab.
    const garrison = tile?.garrison ?? 0;
    // ADR-039 连地: Occupy (and 就地占领 below) requires the target to border the player's territory (occupy
    // would otherwise be rejected server-side with TERRITORY_NOT_CONNECTED) — omitted outright when it doesn't,
    // rather than shown disabled (2026-08-02). Sweep is not gated — it has no connectivity requirement server-side.
    const occupyConnected = this.occupyConnected(tx, ty);
    const buttons: ModalButton[] = [];
    if (occupyConnected) {
      // §4.2: occupy now offers the team picker (troops belong to the card team, retained across battles),
      // with a flat "散兵占领" fallback inside the picker. Old flat-only dialog is reachable via that button.
      buttons.push({ label: t('world.actOccupy'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'occupy'), icon: 'flag' });
    }
    if (garrison > 0) {
      buttons.push({ label: t('world.actSweep'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'sweep'), icon: 'atk' });
    }
    // Move (2026-07-23): station a team on this empty neutral tile (no combat, no claim — it just stands there).
    // 驻守 rule (2026-08-02): 驻扎 garrison only ever defends own or allied territory (see the ally branch above)
    // — neutral land offers 停留 idle only. If a 停留 idle team of MINE already stands here it can 就地占领 this
    // very tile (P4 §4.3) without marching, or be recalled. Enemy stationed teams (mine===false, blanked teamId)
    // never match here — they're not actionable from my menu.
    const stationedNeutral = this.ctx.stationed.find((s) => s.mine !== false && s.x === tx && s.y === ty);
    if (stationedNeutral) {
      // 就地占领 only for a 停留 idle team (a 驻扎 garrison team is locked/busy). Gated by the same ADR-039
      // connectivity pre-check as the march-occupy button above (server re-validates on dispatch).
      if (occupyConnected && stationedNeutral.mode !== 'garrison') {
        buttons.push({ label: t('world.actOccupyInPlace'), action: () => void this.ctx.net.doInPlaceOccupy(tx, ty, stationedNeutral.teamId), icon: 'flag' });
      }
      buttons.push({ label: t('world.actRecallStation'), action: () => void this.ctx.net.doRecallStationed(stationedNeutral.teamId), icon: 'home' });
    } else {
      buttons.push({ label: t('world.actMove'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'move', 'idle'), icon: 'footsteps' });
    }
    // (Relocate moved to the owned-tile branch: §3.4 now requires the target 3×3 to be already fully owned,
    // so relocation is initiated by clicking your own centre tile, not a neutral one.)
    buttons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
    const head: ModalLine = garrison > 0
      ? { text: t('world.garrison').replace('{n}', String(garrison)), icon: 'unit' }
      : { text: t('world.actOccupy'), icon: 'flag' };
    const headLines: ModalLine[] = [head, coordLine(tx, ty)];
    // Resource type + level (§ resourceDensity=1.0 — nearly every neutral tile is a resTyped resource tile)
    // and a recommended-troops line (system NPC garrison strength for this level, ADR-037 §5.4's npcGarrison —
    // the same reference strength the occupy battle resolves against) so the player can size their march
    // before committing, instead of guessing.
    if (tile) {
      const neutralResLine = resLevelLine(tile);
      if (neutralResLine) headLines.push(neutralResLine);
    }
    headLines.push({ text: t('world.recommendTroops').replace('{n}', String(npcGarrison(tile?.level ?? 1))), icon: 'swords' });
    this.ctx.panels.showModal(headLines, buttons);
  }

  // ── Deploy (troop-count dialog) ──────────────────────────────────────────────────
  // Pick how many troops to send for a march action. Presets ¼ / ½ / all of the
  // available pool. March source is the player's main base. Server enforces the
  // per-kind minimums (occupy/attack need OCCUPY_MIN_TROOPS) → toast on reject.

  handleDown(x: number, y: number): void {
    // A mutating request is in flight (ctx.bt) — swallow every tap until it settles, so a double-tap
    // on the shop's Buy band cannot dispatch (and be charged for) the same purchase twice. Same
    // guard the busyTracker doc prescribes and every other scene applies at the top of handleDown.
    if (this.ctx.bt?.busy) return;
    // SLG opening guide chain (ONBOARDING_DESIGN §4.2) — its skip glyph / card button must win
    // before any other hit-test, mirroring the modal-button priority right below. `ctx.guide` is
    // only assigned by WorldMapRendererBuild.build() (real scene construction) — optional-chained
    // since a number of UI tests construct WorldMapContext/WorldMapInput directly without it.
    const guideHit = this.ctx.guide?.currentAction();
    if (guideHit && inRect(x, y, guideHit.rect)) {
      runHit(guideHit);
      return;
    }
    // Modal buttons
    if (this.ctx.modalDimRect) {
      // Scrollable list body (world-info nations/shop tabs) — check this BEFORE firing modal buttons.
      // A press inside the list begins a drag-to-scroll gesture and defers any in-list button tap
      // (Buy/Rename) to pointer-up, dropping it if the pointer drags. Otherwise a drag that started
      // on one of those buttons would fire it instead of scrolling the list.
      const sr = this.ctx.infoScrollRect;
      if (sr && x >= sr.x && x <= sr.x + sr.w && y >= sr.y && y <= sr.y + sr.h) {
        const pending = hitAction(this.ctx.modalBtnRects, x, y);
        this.ctx.infoScrollDragging = true;
        this.ctx.infoScrollDragMoved = false;
        this.ctx.infoScrollDragStartY = y;
        this.ctx.infoScrollDragStartScroll = this.ctx.infoScrollY;
        this.ctx.infoScrollPendingTap = pending;
        return;
      }
      // Outside the scroll list, modal buttons (tabs, close, action row) fire on down.
      if (dispatchHit(this.ctx.modalBtnRects, x, y)) return;
      this.ctx.panels.closeModal();
      return;
    }

    // Zoom / resource-cluster / back / shop / home / auction / marches-badge / replay-badge /
    // chat-bar hit-tests — see headerButtons.ts.
    if (hitTestHeaderButtons(this.ctx, x, y)) return;

    // Team-panel row hit detection: the row's action button first (recall / instant-return / recall a
    // field station), then the rest of the row, which flies the camera to wherever that team is —
    // its own base for a team sitting at home (2026-08-30).
    for (const entry of this.ctx.teamRowRects) {
      // One table per row, in the old chain's order: the three action buttons win over the row
      // body behind them (hitTest is first-pushed-wins, same as the `return`s used to be).
      const rowHits: Hit[] = [];
      const { marchId, stationedTeamId } = entry;
      if (entry.recallRect && marchId) {
        rowHits.push({ rect: entry.recallRect, fn: () => void this.ctx.net.doRecall(marchId, entry.worldId) });
      }
      if (entry.instantReturnRect && marchId) {
        rowHits.push({ rect: entry.instantReturnRect, fn: () => void this.ctx.net.doInstantReturn(marchId, entry.worldId) });
      }
      if (entry.recallStationRect && stationedTeamId) {
        rowHits.push({ rect: entry.recallStationRect, fn: () => void this.ctx.net.doRecallStationed(stationedTeamId) });
      }
      if (entry.stopHoldRect && entry.stopHold) {
        const { teamId, kind } = entry.stopHold;
        rowHits.push({ rect: entry.stopHoldRect, fn: () => void this.ctx.net.doStopHold(teamId, kind) });
      }
      rowHits.push({
        rect: entry.rowRect,
        fn: () => { this.ctx.view.centerAt(entry.jumpX, entry.jumpY); this.ctx.view.renderMap(); },
      });
      if (dispatchHit(rowHits, x, y)) return;
    }

    // Begin drag (only inside the map band — below the header bar, above the chat HUD)
    if (y > this.ctx.topInset && y < this.ctx.h - HUD_H) {
      this.ctx.dragging = true;
      this.ctx.dragMoved = false;
      this.ctx.dragStartX = x - this.ctx.panX;
      this.ctx.dragStartY = y - this.ctx.panY;
    }
  }

  handleMove(x: number, y: number): void {
    if (this.ctx.infoScrollDragging) {
      const dy = y - this.ctx.infoScrollDragStartY;
      if (Math.abs(dy) > 6) this.ctx.infoScrollDragMoved = true;
      if (this.ctx.infoScrollDragMoved) {
        const next = Math.max(0, Math.min(this.ctx.infoMaxScroll, this.ctx.infoScrollDragStartScroll - dy));
        if (next !== this.ctx.infoScrollY) {
          this.ctx.infoScrollY = next;
          this.ctx.infoScrollRerender?.();
        }
      }
      return;
    }
    if (!this.ctx.dragging) return;
    const dx = x - (this.ctx.dragStartX + this.ctx.panX);
    const dy = y - (this.ctx.dragStartY + this.ctx.panY);
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) this.ctx.dragMoved = true;
    if (this.ctx.dragMoved) {
      this.ctx.panX = x - this.ctx.dragStartX;
      this.ctx.panY = y - this.ctx.dragStartY;
      this.ctx.view.clampPan();
      // L1/L2: pool reposition — cheap, no Graphics.clear() needed.
      // L3: just flag dirty; actual redraw happens in update() at most 60fps.
      if (this.ctx.zoom < 3) {
        this.ctx.view.refreshPool();
      } else {
        this.ctx.l3Dirty = true;
        // refreshPool() short-circuits the tile pool at L3 but still repositions city
        // sprites (refreshCityLayer) — without this, city sprites keep whatever screen
        // position they were last drawn at and appear to drift with the camera instead
        // of tracking the map while panning at L3.
        this.ctx.view.refreshCityLayer();
      }
      // The overlay ink is NOT rebuilt here, only marked: a pointer-move can fire more often than
      // the display refreshes (120 Hz panels, coalesced touch batches), and rebuilding the veil +
      // frontier + zones + arrows per EVENT is how a drag ends up doing that work two or three times
      // for one visible frame. lifecycle.update() consumes the flag once per frame instead.
      this.ctx.overlayInkDirty = true;
    }
  }

  handleUp(x: number, y: number): void {
    if (this.ctx.infoScrollDragging) {
      this.ctx.infoScrollDragging = false;
      // Fire a deferred in-list button tap only for a genuine tap (the pointer never dragged).
      const tap = this.ctx.infoScrollPendingTap;
      this.ctx.infoScrollPendingTap = null;
      if (tap && !this.ctx.infoScrollDragMoved) tap();
      return;
    }
    if (!this.ctx.dragging) return;
    const wasDragging = this.ctx.dragMoved;
    this.ctx.dragging = false;

    if (!wasDragging && y > this.ctx.topInset && y < this.ctx.h - HUD_H) {
      const { x: tx, y: ty } = this.ctx.view.screenToTile(x, y);
      this.onTileClick(tx, ty);
    } else if (wasDragging) {
      // Lazy-load new viewport tiles after pan
      void this.ctx.net.loadMapViewport().then(() => {
        if (!this.ctx.destroyed) this.ctx.view.renderMap();
      });
    }
  }

  /** Mouse-wheel scroll over the world-info panel's scrollable list (browser only). */
  handleWheel(x: number, y: number, deltaY: number): void {
    const sr = this.ctx.infoScrollRect;
    if (!sr || x < sr.x || x > sr.x + sr.w || y < sr.y || y > sr.y + sr.h) return;
    const next = Math.max(0, Math.min(this.ctx.infoMaxScroll, this.ctx.infoScrollY + deltaY));
    if (next !== this.ctx.infoScrollY) {
      this.ctx.infoScrollY = next;
      this.ctx.infoScrollRerender?.();
    }
  }
}
