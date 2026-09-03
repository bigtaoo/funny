import { t } from '../../i18n';
import { baseFootprintCells, baseFootprintInBounds, npcGarrison } from '@nw/shared';
import { HUD_H } from './logic/constants';
import { hitTestHeaderButtons } from './WorldMapInput/headerButtons';
import { showCityPanel, type CityPanelState } from './WorldMapInput/cityPanel';
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
   * Mirrors worldsvc's footprintOwnedBy (§3.4): true iff the whole 3×3 block anchored at (ax,ay) is owned by
   * the player right now — in bounds and every cell cached as `mine`. This is the relocate gate: the capital
   * may only move onto a 3×3 the player already fully holds, so a cell that is neutral, enemy, or not yet
   * revealed (uncached → not provably mine) disqualifies the block. The server re-validates on relocate.
   */
  private footprintAllMine(ax: number, ay: number): boolean {
    if (!baseFootprintInBounds(ax, ay, this.ctx.mapW, this.ctx.mapH)) return false;
    for (const { x, y } of baseFootprintCells(ax, ay)) {
      if (!this.ctx.tileCache.get(`${x}:${y}`)?.mine) return false;
    }
    return true;
  }

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
      // My tile — reinforce (march from base) + abandon. Base itself: no actions.
      const [bx, by] = me.mainBaseTile ? this.ctx.parseTileId(me.mainBaseTile) : [-1, -1];
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
        if (this.ctx.guideStep === 'step1') {
          this.ctx.cb.setFlag?.('guide.world.step1', true);
          this.ctx.guideStep = null;
        }
        this.ctx.cb.onOpenCity();
        return;
      }
      const tileKey = `${this.ctx.cb.worldId}:${tx}:${ty}`;
      // Only MY stationed team here can be recalled — ctx.stationed now also carries enemy teams (P4), whose
      // teamId is blanked; matching one would send an un-actionable recall.
      const stationedHere = this.ctx.stationed.find((s) => s.mine !== false && s.x === tx && s.y === ty);
      const myButtons: ModalButton[] = [
        { label: t('world.actReinforce'), action: () => this.ctx.panels.showDeployDialog(tx, ty, 'reinforce'), icon: 'swords' },
        // Move (2026-07-23): park a home team on this tile. ADR-051 (P4) two intents — 移动到此(停留 idle, free to
        // re-command) vs 移动并驻扎 (garrison, defends its 3×3 footprint + intercepts passers, stays busy). Recall
        // sends a team already stationed here back home. One stationed team per tile → offer Move/Garrison only
        // when none of mine stands here.
        ...(stationedHere
          ? [{ label: t('world.actRecallStation'), action: () => void this.ctx.net.doRecallStationed(stationedHere.teamId), icon: 'home' as const }]
          : [
              // The 停留/驻扎 pair, told apart by movement-vs-presence: footprints for a team that
              // just walks there and stays free to re-command, a pitched tent for one that digs in.
              // Both were borrowing something else until batch 9 (`spd`'s chevrons and `unit`'s
              // helmet); the helmet stays two lines further down, where it means "troops present".
              { label: t('world.actMove'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'move', 'idle'), icon: 'footsteps' as const },
              { label: t('world.actGarrison'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'move', 'garrison'), icon: 'camp' as const },
            ]),
        { label: t('world.actDefense'), action: () => { this.ctx.panels.closeModal(); this.ctx.cb.onOpenDefense(tileKey); }, icon: 'defenseTabIcon' },
      ];
      // Watchtower (§18 G5 V2): build a long-radius persistent vision source on an owned tile. If a tower already exists, show a status line instead of the build button.
      if (!tile.watchtower) {
        myButtons.push({ label: t('world.actWatchtower'), action: () => this.ctx.net.confirmWatchtower(tx, ty), icon: 'watchtower' });
      }
      // ADR-051 (P5): player structures — one per tile. Build an arrow tower (chips passing enemies over 9 cells)
      // or a blocker (forces enemy detours) on own territory; demolish one's own structure. (Not offered on the
      // base anchor — that branch returns above.)
      if (tile.structure) {
        myButtons.push({ label: t('world.actDemolish'), action: () => void this.ctx.net.doDemolishStructure(tx, ty), icon: 'hammer' });
      } else {
        // These two plus the watchtower above can all be in this menu at once, which is why their
        // art was drawn as one set and reviewed side by side at 26px (batch 9): a wide open trestle,
        // a narrow closed shaft with an arrow, a low spiked lattice. `hammer` -- which all three
        // shared while they had no art -- stays on demolish, where "this is construction work" is
        // the whole message.
        myButtons.push({ label: t('world.actArrowTower'), action: () => this.ctx.net.confirmBuildStructure(tx, ty, 'arrowTower'), icon: 'arrowTower' });
        myButtons.push({ label: t('world.actBlocker'), action: () => this.ctx.net.confirmBuildStructure(tx, ty, 'blocker'), icon: 'blocker' });
      }
      // Relocate here (§3.4): the capital may only move onto a 3×3 block the player already fully owns —
      // this clicked cell as centre plus all 8 neighbours. Only offered once that ring is fully mine
      // (unsupported options are omitted outright rather than shown disabled, 2026-08-02).
      if (me.mainBaseTile && this.footprintAllMine(tx, ty)) {
        myButtons.push({ label: t('world.actRelocate'), action: () => this.ctx.net.confirmRelocate(tx, ty), icon: 'castle' });
      }
      myButtons.push({ label: t('world.actAbandon'), action: () => this.ctx.net.doAbandon(tx, ty), icon: 'scrap' });
      myButtons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
      const head: ModalLine[] = [{ text: t('world.mine'), icon: 'flag' }];
      if (tile.watchtower) head.push({ text: t('world.hasWatchtower'), icon: 'watchtower' });
      if (tile.structure) head.push(structureLine(tile.structure.kind));
      head.push(coordLine(tx, ty));
      const mineBaseLine = baseLevelLine(tile);
      if (mineBaseLine) head.push(mineBaseLine);
      const mineResLine = resLevelLine(tile);
      if (mineResLine) head.push(mineResLine);
      this.ctx.panels.showModal(head, myButtons);
      return;
    }

    if (tile?.ally || tile?.sectmate || tile?.allySect) {
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
      const stationedAlly = this.ctx.stationed.find((s) => s.mine !== false && s.x === tx && s.y === ty);
      if (stationedAlly) {
        allyButtons.push({ label: t('world.actRecallStation'), action: () => void this.ctx.net.doRecallStationed(stationedAlly.teamId), icon: 'home' });
      } else {
        allyButtons.push({ label: t('world.actGarrison'), action: () => void this.ctx.net.showTeamPicker(tx, ty, 'move', 'garrison'), icon: 'camp' });
      }
      allyButtons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
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
      this.ctx.panels.showModal(allyHead, allyButtons);
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
      buttons.push({ label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' });
      const enemyHead: ModalLine[] = [
        { text: t('world.enemyTile'), icon: 'flag' },
        { text: ownerLine, icon: 'avatarTabIcon' },
        coordLine(tx, ty),
      ];
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
        // My own pending hold — nothing to do but watch the countdown (no reinforcement in v1).
        this.ctx.panels.showModal([
          { text: t('world.occupyingMine').replace('{sec}', String(secLeft)), icon: 'hourglassMd' },
          coordLine(tx, ty),
        ], [
          { label: t('common.close'), action: () => this.ctx.panels.closeModal(), icon: 'close' },
        ]);
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
        this.ctx.view.renderOverlay();
      } else {
        this.ctx.l3Dirty = true;
        // refreshPool() short-circuits the tile pool at L3 but still repositions city
        // sprites (refreshCityLayer) — without this, city sprites keep whatever screen
        // position they were last drawn at and appear to drift with the camera instead
        // of tracking the map while panning at L3.
        this.ctx.view.refreshCityLayer();
        this.ctx.view.renderOverlay();
      }
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
