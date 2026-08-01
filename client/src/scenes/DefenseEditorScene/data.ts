// Data loading + save/persist for the defense editor: fetch team/defense config, decode/encode army
// state, and the network-writing actions (save formation, fill troops).
import { t, type TranslationKey } from '../../i18n';
import { ui as C } from '../../render/sketchUi';
import type { WorldApiClient, ArmyEntry } from '../../net/WorldApiClient';
import { WorldApiError } from '../../net/WorldApiClient';
import { ATTACK_LANES, UNIT_BLUEPRINTS } from '../../game/config';
import { UnitType, BuildingType } from '../../game/types';
import type { CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, troopCap, cardPower } from '../../game/meta/cardDefs';
import {
  type Constructor, type DefenseEditorSceneBaseCtor, type GarrisonEntry,
  COLLECTED_UNITS, COLLECTED_BUILDINGS, MAX_BASE_LEVEL, msCountdown,
} from './base';

export interface DataHandlers {
  loadData(): Promise<void>;
  applyArmy(army: ArmyEntry[]): void;
  applyConfig(cfg: Record<string, unknown>): void;
  buildArmy(): ArmyEntry[];
  persistTeam(): Promise<void>;
  doSave(): Promise<void>;
  doFillTroops(): Promise<void>;
  errorMsg(e: unknown): string;
  injuredCardMsg(raw: string): string;
}

export function DataMixin<TBase extends DefenseEditorSceneBaseCtor>(Base: TBase): TBase & Constructor<DataHandlers> {
  return class extends Base {
    async loadData(): Promise<void> {
      try {
        if (this.cb.target.mode === 'attack') {
          const [teams, me] = await Promise.all([
            this.cb.worldApi.getTeams(this.cb.worldId),
            this.cb.worldApi.getMe(this.cb.worldId),
          ]);
          if (!this.destroyed) {
            this.teams = teams;
            this.cardState = me.cardState ?? {};
            this.troops = me.troops ?? 0;
            const team = teams.find((tm) => tm.id === (this.cb.target as { teamId: string }).teamId);
            if (team) {
              this.applyArmy(team.army);
              this.autoReturn = !!team.autoReturn;
              this.leaderCardId = team.leaderCardId ?? null;
            }
          }
        } else {
          const cfg = await this.cb.worldApi.getDefense(this.cb.worldId, this.cb.target.tileKey);
          if (cfg && !this.destroyed) this.applyConfig(cfg as Record<string, unknown>);
        }
      } catch { /* offline / unset — start blank */ }
      this.loading = false;
      if (!this.destroyed) this.render();
    }

    /**
     * Decode a stored attacker army (CC-3 hero cards) into the garrison map. Each entry must carry a
     * cardInstanceId resolving to a card the player still owns; unitType is derived from CARD_DEFS, troop
     * count from the live cardState ledger (not persisted on the entry itself). Legacy entries from before
     * the 2026-07-17 card migration (unitType/initialHp, no cardInstanceId) are dropped silently — they
     * have no card to resolve to and would just re-hit the flat-pool bug this migration fixes.
     */
    applyArmy(army: ArmyEntry[]): void {
      this.garrison.clear();
      const cardInv = this.cb.getSave?.().cardInv ?? {};
      for (const e of army) {
        if (!e || typeof e !== 'object') continue;
        const { col, row, cardInstanceId } = e;
        if (!cardInstanceId) continue;
        if (typeof col !== 'number' || !(ATTACK_LANES as readonly number[]).includes(col)) continue;
        if (typeof row !== 'number' || !(this.gRows as readonly number[]).includes(row)) continue;
        const inst = cardInv[cardInstanceId];
        const def = inst ? CARD_DEFS[inst.defId] : undefined;
        if (!def) continue; // stale/unknown card (sold, migrated away) — drop
        const hp = this.cardState[cardInstanceId]?.currentTroops ?? 0;
        this.garrison.set(`${col}:${row}`, { unitType: def.unitType as UnitType, hp, cardInstanceId });
      }
    }

    /** Decode a stored DefenseConfig subset back into editor state (tolerant of junk). */
    applyConfig(cfg: Record<string, unknown>): void {
      this.buildings.clear();
      this.garrison.clear();
      const g = cfg.garrison;
      if (Array.isArray(g)) {
        for (const e of g) {
          if (!e || typeof e !== 'object') continue;
          const { unitType, col, row } = e as Record<string, unknown>;
          if (typeof unitType === 'string' && (COLLECTED_UNITS as string[]).includes(unitType)
            && typeof col === 'number' && (ATTACK_LANES as readonly number[]).includes(col)
            && typeof row === 'number' && (this.gRows as readonly number[]).includes(row)) {
            const ut = unitType as UnitType;
            this.garrison.set(`${col}:${row}`, { unitType: ut, hp: UNIT_BLUEPRINTS[ut].hp });
          }
        }
      }
      const b = cfg.defenderBuildings;
      if (Array.isArray(b)) {
        for (const e of b) {
          if (!e || typeof e !== 'object') continue;
          const { buildingType, col } = e as Record<string, unknown>;
          if (typeof buildingType === 'string' && (COLLECTED_BUILDINGS as string[]).includes(buildingType)
            && typeof col === 'number' && (ATTACK_LANES as readonly number[]).includes(col)) {
            this.buildings.set(col, buildingType as BuildingType);
          }
        }
      }
      const lv = cfg.defenderBaseLevel;
      this.baseLevel = typeof lv === 'number' ? Math.max(0, Math.min(MAX_BASE_LEVEL, Math.floor(lv))) : 0;
    }

    /** Attacker army: each placed cell is a hero card at that position — troops live in cardState, not here. */
    buildArmy(): ArmyEntry[] {
      return [...this.garrison.entries()].map(([key, entry]) => {
        const [col, row] = key.split(':').map(Number);
        return { cardInstanceId: entry.cardInstanceId!, col: col!, row: row! };
      });
    }

    /**
     * Attack mode: persist this team slot (setTeams merge) so every placed card gets a server-side
     * teamId. Shared by doSave (explicit Save) and doFillTroops (auto-save before 分兵, since
     * distributeTroops rejects any card not yet assigned to a team). setTeams only frees/clears troops
     * for cards *removed* from all teams — kept cards keep their currentTroops, so calling this before
     * a fill is safe.
     */
    async persistTeam(): Promise<void> {
      if (this.cb.target.mode !== 'attack') return;
      const { teamId } = this.cb.target;
      const army = this.buildArmy();
      const next = this.teams.filter((tm) => tm.id !== teamId);
      const leaderCardId = this.leaderCardId && army.some((e) => e.cardInstanceId === this.leaderCardId)
        ? this.leaderCardId
        : undefined;
      // Slot names have no custom-naming UI yet (v1) — persist '' rather than the locale-snapshotted
      // teamName the editor was opened with, so CityScene's `team?.name || teamSlotName(i)` fallback
      // always renders live in the player's *current* language instead of freezing whatever language
      // was active the first time this slot was saved (was producing mixed "Team 1"/"队伍 3" rows).
      next.push({ id: teamId, name: '', army, autoReturn: this.autoReturn, leaderCardId });
      await this.cb.worldApi.setTeams(this.cb.worldId, next);
      this.teams = next;
    }

    async doSave(): Promise<void> {
      if (this.saving) return;
      this.saving = true;
      try {
        if (this.cb.target.mode === 'attack') {
          await this.persistTeam();
        } else {
          const config = {
            garrison: [...this.garrison.entries()].map(([key, entry]) => {
              const [col, row] = key.split(':').map(Number);
              return { unitType: entry.unitType, col, row };
            }),
            defenderBuildings: [...this.buildings.entries()].map(([col, buildingType]) => ({ buildingType, col })),
            defenderBaseLevel: this.baseLevel,
          };
          await this.cb.worldApi.setDefense(this.cb.worldId, this.cb.target.tileKey, config);
        }
        this.showToast(t('world.defense.saved'));
        this.saving = false;
        this.cb.onBack();
      } catch (e) {
        this.saving = false;
        this.showToast(this.errorMsg(e), C.red);
        this.render();
      }
    }

    /**
     * §6.5 一键补满: distribute the base troop pool to this formation's placed cards, highest combat-power
     * first, up to each card's troopCap. This is the only troop-allocation control in the editor now —
     * the per-card manual stepper was removed 2026-07-23 (redundant with this bulk fill).
     */
    async doFillTroops(): Promise<void> {
      if (this.filling || this.cb.target.mode !== 'attack') return;
      const cardInv = this.cb.getSave?.().cardInv ?? {};
      const equipmentInv = this.cb.getSave?.().equipmentInv ?? {};
      const placed = [...this.garrison.values()]
        .filter((e) => !!e.cardInstanceId)
        .map((e) => ({ entry: e, card: cardInv[e.cardInstanceId!] }))
        .filter((x): x is { entry: GarrisonEntry; card: CardInstance } => !!x.card);
      if (placed.length === 0) return;
      placed.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));

      let pool = this.troops;
      const allocations: Record<string, number> = {};
      for (const { entry, card } of placed) {
        if (pool <= 0) break;
        const current = this.cardState[entry.cardInstanceId!]?.currentTroops ?? 0;
        const gap = Math.max(0, troopCap(card) - current);
        if (gap <= 0) continue;
        const amount = Math.min(gap, pool);
        allocations[entry.cardInstanceId!] = amount;
        pool -= amount;
      }

      if (Object.keys(allocations).length === 0) {
        this.showToast(t('world.team.fillNone'), C.red);
        return;
      }

      this.filling = true;
      try {
        // Auto-save the formation first: a card placed on the grid but not yet saved has no server-side
        // teamId, so distributeTroops would reject it ("Card X is not assigned to a team"). Persisting
        // here means the player can place cards and hit 分兵 without a separate Save tap.
        await this.persistTeam();
        await this.cb.worldApi.distributeTroops(this.cb.worldId, allocations);
        let total = 0;
        for (const [id, amount] of Object.entries(allocations)) {
          total += amount;
          const cs = this.cardState[id];
          const nextTroops = (cs?.currentTroops ?? 0) + amount;
          this.cardState[id] = { ...cs, currentTroops: nextTroops };
          const entry = [...this.garrison.values()].find((e) => e.cardInstanceId === id);
          if (entry) entry.hp = nextTroops;
        }
        this.troops -= total;
        this.showToast(t('world.team.fillDone').replace('{n}', String(total)));
      } catch (e) {
        this.showToast(this.errorMsg(e), C.red);
      }
      this.filling = false;
      this.render();
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
      const match = /^Card (\S+) is injured and cannot be assigned until (\d+)$/.exec(raw);
      if (!match) return t('world.defense.saveFail');
      const [, cardId, untilStr] = match;
      const card = this.cb.getSave?.().cardInv?.[cardId];
      const name = card ? t(`card.${card.defId}.name` as TranslationKey) : cardId;
      const key = this.cellForCard(cardId);
      if (key) this.garrison.delete(key);
      return t('world.team.cardInjuredRemoved')
        .replace('{name}', name)
        .replace('{time}', msCountdown(Number(untilStr), Date.now()));
    }
  };
}
