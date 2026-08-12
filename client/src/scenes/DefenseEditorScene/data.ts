// Data loading + save/persist for the defense editor: fetch team/defense config, decode/encode army
// state, and the network-writing actions (save formation, fill troops).
import { t, type TranslationKey } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import type { ArmyEntry } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { ATTACK_LANES, UNIT_BLUEPRINTS } from '@nw/engine/config';
import { fromFp } from '@nw/engine/math/fixed';
import { UnitType, BuildingType } from '@nw/engine/types';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, troopCap, cardPower } from '../../game/meta/cardDefs';
import { COLLECTED_UNITS, COLLECTED_BUILDINGS, MAX_BASE_LEVEL, msCountdown } from './core';
import type { DefenseEditorSceneCore, GarrisonEntry } from './core';

export interface DataHandlers {
  loadData(): Promise<void>;
  applyArmy(army: ArmyEntry[]): void;
  applyConfig(cfg: Record<string, unknown>): void;
  persistTeam(): Promise<void>;
  doSave(): Promise<void>;
  doFillTroops(): Promise<void>;
  errorMsg(e: unknown): string;
  injuredCardMsg(raw: string): string;
}

/** Data loading/save domain (see ../DefenseEditorScene.ts assembly + ./core.ts for the shared state). */
export class DataPanel implements DataHandlers {
  constructor(private readonly core: DefenseEditorSceneCore) {}

  async loadData(): Promise<void> {
    const core = this.core;
    try {
      if (core.cb.target.mode === 'attack') {
        const [teams, me] = await Promise.all([
          core.cb.worldApi.getTeams(core.cb.worldId),
          core.cb.worldApi.getMe(core.cb.worldId),
        ]);
        if (!core.destroyed) {
          core.teams = teams;
          core.cardState = me.cardState ?? {};
          core.troops = me.troops ?? 0;
          const team = teams.find((tm) => tm.id === (core.cb.target as { teamId: string }).teamId);
          if (team) {
            this.applyArmy(team.army);
            core.autoReturn = !!team.autoReturn;
            core.leaderCardId = team.leaderCardId ?? null;
          }
        }
      } else {
        const cfg = await core.cb.worldApi.getDefense(core.cb.worldId, core.cb.target.tileKey);
        if (cfg && !core.destroyed) this.applyConfig(cfg as Record<string, unknown>);
      }
    } catch {
      /* offline / unset — start blank */
    }
    core.loading = false;
    if (!core.destroyed) core.render();
  }

  /**
   * Decode a stored attacker army (CC-3 hero cards) into the garrison map. Each entry must carry a
   * cardInstanceId resolving to a card the player still owns; unitType is derived from CARD_DEFS, troop
   * count from the live cardState ledger (not persisted on the entry itself). Legacy entries from before
   * the 2026-07-17 card migration (unitType/initialHp, no cardInstanceId) are dropped silently — they
   * have no card to resolve to and would just re-hit the flat-pool bug this migration fixes.
   */
  applyArmy(army: ArmyEntry[]): void {
    const core = this.core;
    core.garrison.clear();
    const cardInv = core.cb.getSave?.().cardInv ?? {};
    for (const e of army) {
      if (!e || typeof e !== 'object') continue;
      const { col, row, cardInstanceId } = e;
      if (!cardInstanceId) continue;
      if (typeof col !== 'number' || !(ATTACK_LANES as readonly number[]).includes(col)) continue;
      if (typeof row !== 'number' || !(core.gRows as readonly number[]).includes(row)) continue;
      const inst = cardInv[cardInstanceId];
      const def = inst ? CARD_DEFS[inst.defId] : undefined;
      if (!def) continue; // stale/unknown card (sold, migrated away) — drop
      const hp = core.cardState[cardInstanceId]?.currentTroops ?? 0;
      core.garrison.set(`${col}:${row}`, {
        unitType: def.unitType as UnitType,
        hp,
        cardInstanceId,
      });
    }
  }

  /** Decode a stored DefenseConfig subset back into editor state (tolerant of junk). */
  applyConfig(cfg: Record<string, unknown>): void {
    const core = this.core;
    core.buildings.clear();
    core.garrison.clear();
    const g = cfg.garrison;
    if (Array.isArray(g)) {
      for (const e of g) {
        if (!e || typeof e !== 'object') continue;
        const { unitType, col, row } = e as Record<string, unknown>;
        if (
          typeof unitType === 'string' &&
          (COLLECTED_UNITS as string[]).includes(unitType) &&
          typeof col === 'number' &&
          (ATTACK_LANES as readonly number[]).includes(col) &&
          typeof row === 'number' &&
          (core.gRows as readonly number[]).includes(row)
        ) {
          const ut = unitType as UnitType;
          core.garrison.set(`${col}:${row}`, { unitType: ut, hp: fromFp(UNIT_BLUEPRINTS[ut].hp_fp) });
        }
      }
    }
    const b = cfg.defenderBuildings;
    if (Array.isArray(b)) {
      for (const e of b) {
        if (!e || typeof e !== 'object') continue;
        const { buildingType, col } = e as Record<string, unknown>;
        if (
          typeof buildingType === 'string' &&
          (COLLECTED_BUILDINGS as string[]).includes(buildingType) &&
          typeof col === 'number' &&
          (ATTACK_LANES as readonly number[]).includes(col)
        ) {
          core.buildings.set(col, buildingType as BuildingType);
        }
      }
    }
    const lv = cfg.defenderBaseLevel;
    core.baseLevel =
      typeof lv === 'number' ? Math.max(0, Math.min(MAX_BASE_LEVEL, Math.floor(lv))) : 0;
  }

  /**
   * Attack mode: persist this team slot (setTeams merge) so every placed card gets a server-side
   * teamId. Shared by doSave (explicit Save) and doFillTroops (auto-save before 分兵, since
   * distributeTroops rejects any card not yet assigned to a team). setTeams only frees/clears troops
   * for cards *removed* from all teams — kept cards keep their currentTroops, so calling this before
   * a fill is safe.
   */
  async persistTeam(): Promise<void> {
    const core = this.core;
    if (core.cb.target.mode !== 'attack') return;
    const { teamId } = core.cb.target;
    const army = core.buildArmy();
    const next = core.teams.filter((tm) => tm.id !== teamId);
    const leaderCardId =
      core.leaderCardId && army.some((e) => e.cardInstanceId === core.leaderCardId)
        ? core.leaderCardId
        : undefined;
    // Slot names have no custom-naming UI yet (v1) — persist '' rather than the locale-snapshotted
    // teamName the editor was opened with, so CityScene's `team?.name || teamSlotName(i)` fallback
    // always renders live in the player's *current* language instead of freezing whatever language
    // was active the first time this slot was saved (was producing mixed "Team 1"/"队伍 3" rows).
    next.push({ id: teamId, name: '', army, autoReturn: core.autoReturn, leaderCardId });
    await core.cb.worldApi.setTeams(core.cb.worldId, next);
    core.teams = next;
  }

  async doSave(): Promise<void> {
    const core = this.core;
    if (core.saving) return;
    core.saving = true;
    try {
      if (core.cb.target.mode === 'attack') {
        await this.persistTeam();
      } else {
        const config = {
          garrison: [...core.garrison.entries()].map(([key, entry]) => {
            const [col, row] = key.split(':').map(Number);
            return { unitType: entry.unitType, col, row };
          }),
          defenderBuildings: [...core.buildings.entries()].map(([col, buildingType]) => ({
            buildingType,
            col,
          })),
          defenderBaseLevel: core.baseLevel,
        };
        await core.cb.worldApi.setDefense(core.cb.worldId, core.cb.target.tileKey, config);
      }
      core.showToast(t('world.defense.saved'));
      core.saving = false;
      core.cb.onBack();
    } catch (e) {
      core.saving = false;
      core.showToast(this.errorMsg(e), C.red);
      core.render();
    }
  }

  /**
   * §6.5 一键补满: distribute the base troop pool to this formation's placed cards, highest combat-power
   * first, up to each card's troopCap. This is the only troop-allocation control in the editor now —
   * the per-card manual stepper was removed 2026-07-23 (redundant with this bulk fill).
   */
  async doFillTroops(): Promise<void> {
    const core = this.core;
    if (core.filling || core.cb.target.mode !== 'attack') return;
    const cardInv = core.cb.getSave?.().cardInv ?? {};
    const equipmentInv = core.cb.getSave?.().equipmentInv ?? {};
    const placed = [...core.garrison.values()]
      .filter((e) => !!e.cardInstanceId)
      .map((e) => ({ entry: e, card: cardInv[e.cardInstanceId!] }))
      .filter((x): x is { entry: GarrisonEntry; card: CardInstance } => !!x.card);
    if (placed.length === 0) return;
    placed.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));

    let pool = core.troops;
    const allocations: Record<string, number> = {};
    for (const { entry, card } of placed) {
      if (pool <= 0) break;
      const current = core.cardState[entry.cardInstanceId!]?.currentTroops ?? 0;
      const gap = Math.max(0, troopCap(card) - current);
      if (gap <= 0) continue;
      const amount = Math.min(gap, pool);
      allocations[entry.cardInstanceId!] = amount;
      pool -= amount;
    }

    if (Object.keys(allocations).length === 0) {
      core.showToast(t('world.team.fillNone'), C.red);
      return;
    }

    core.filling = true;
    try {
      // Auto-save the formation first: a card placed on the grid but not yet saved has no server-side
      // teamId, so distributeTroops would reject it ("Card X is not assigned to a team"). Persisting
      // here means the player can place cards and hit 分兵 without a separate Save tap.
      await this.persistTeam();
      await core.cb.worldApi.distributeTroops(core.cb.worldId, allocations);
      let total = 0;
      for (const [id, amount] of Object.entries(allocations)) {
        total += amount;
        const cs = core.cardState[id];
        const nextTroops = (cs?.currentTroops ?? 0) + amount;
        core.cardState[id] = { ...cs, currentTroops: nextTroops };
        const entry = [...core.garrison.values()].find((e) => e.cardInstanceId === id);
        if (entry) entry.hp = nextTroops;
      }
      core.troops -= total;
      core.showToast(t('world.team.fillDone').replace('{n}', String(total)));
    } catch (e) {
      core.showToast(this.errorMsg(e), C.red);
    }
    core.filling = false;
    core.render();
  }

  errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      if (e.code === 'TILE_NOT_OWNED') return t('world.err.notOwner');
      if (e.code === 'CARD_INJURED') return this.injuredCardMsg(e.message);
      return e.message;
    }
    return t('world.defense.saveFail');
  }

  /**
   * CARD_INJURED's e.message is a diagnostic string ("Card <id> is injured and cannot be assigned
   * until <ms>") meant for logs, not players — surfacing it raw left the toast unreadable (bare
   * instance id + epoch ms). Parse the id back out, name the card, show a readable countdown, and
   * drop it from the in-progress formation: the slot was already invalid the moment the server
   * rejected the save, so leaving it placed would just repeat the same error on the next Save/Fill.
   */
  injuredCardMsg(raw: string): string {
    const core = this.core;
    const match = /^Card (\S+) is injured and cannot be assigned until (\d+)$/.exec(raw);
    if (!match) return t('world.defense.saveFail');
    const [, cardId, untilStr] = match;
    const card = core.cb.getSave?.().cardInv?.[cardId];
    const name = card ? t(`card.${card.defId}.name` as TranslationKey) : cardId;
    const key = core.cellForCard(cardId);
    if (key) core.garrison.delete(key);
    return t('world.team.cardInjuredRemoved')
      .replace('{name}', name)
      .replace('{time}', msCountdown(Number(untilStr), Date.now()));
  }
}
