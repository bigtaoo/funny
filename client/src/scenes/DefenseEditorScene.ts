// DefenseEditorScene — SLG universal half-field deployment editor (S8-9 C3 + G3-2c generalized to offense/defense)
//
// Two modes, distinguished by target.mode:
//
// ① Defense (mode='defense'): edit the defense config for the home base (tileKey='base') or
//    allied/own territory (tileKey='{x}:{y}') = engine LevelDefinition restricted subset (U8/U10) —
//    defender (Top) half garrison + building row defenderBuildings + defenderBaseLevel(0..BASE_UPGRADE_COSTS.length).
//    Save via setDefense (overwrite).
//
// ② Attack (mode='attack', G3-2c §16.2 / A7 §16.5, migrated to CC-3 hero cards 2026-07-17): edit a
//    pre-deployment attack team template — attacker (Bottom) half with hero cards from the player's
//    roster (SaveData.cardInv) pre-placed; no buildings / no base upgrades (attacker places cards
//    only). A card can occupy only one cell (placing it elsewhere moves it); committed troops = sum
//    of each placed card's cardState.currentTroops (server-authoritative ledger, not a client HP
//    slider). Save via getTeams→replace slot→setTeams, entries are {cardInstanceId, col, row}.
//
//    Previously (pre-2026-07-17) this mode used the same raw "collected units" palette as defense
//    mode with a client-side 25%-100% HP slider (ArmyEntry.unitType/initialHp) — that path never
//    touched cardState, so combatMarch.ts's card-army exemption from the flat troop pool never
//    applied to teams built here, causing "team shows troops but march says insufficient troops"
//    (the legacy `pw.troops < troops` gate still fired). See slg-occupy-team-only-troops memory.
//
// "Collected units" constraint (U8, defense mode only): palette only lists unit/building types from
// card definitions (CARD_DEFINITIONS); PvE-only units naturally excluded. During a siege, worldsvc
// runs the engine headless with the attacker army + defender config to compute the authoritative
// result (§16.8).

import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../layout/ILayout';
import type { InputManager } from '../inputSystem/InputManager';
import type { Scene } from './SceneManager';
import { t, type TranslationKey } from '../i18n';
import { ui as C, txt, buildPaperBackground, sketchPanel, seedFor, tearDownChildren } from '../render/sketchUi';
import { showToastMessage } from '../net/log';
import { buildDecorCLayer } from '../render/decorCLayer';
import { FS } from '../render/fontScale';
import { drawSceneHeader, HEADER_ACCENT } from '../ui/widgets/SceneHeader';
import { drawScrollIndicator } from '../ui/widgets/ScrollIndicator';
import { peekViewportH } from '../ui/widgets/scrollPeek';
import { ScrollTapGesture } from '../ui/scrollTapGesture';
import { UNIT_ART_URLS, getArtTexture } from '../render/cardArt';
import type { WorldApiClient, TeamTemplate, ArmyEntry, CardSLGState } from '../net/WorldApiClient';
import { WorldApiError } from '../net/WorldApiClient';
import { ATTACK_LANES, BASE_COLS, BASE_UPGRADE_COSTS, CARD_DEFINITIONS, UNIT_BLUEPRINTS } from '../game/config';
import { CardType, UnitType, BuildingType } from '../game/types';
import type { SaveData, CardInstance } from '../game/meta/SaveData';
import { CARD_DEFS, troopCap, cardPower } from '../game/meta/cardDefs';
import { CARD_TEAM_MAX_SIZE } from '@nw/shared';

/** Max defender base upgrade level the engine schema accepts (0..BASE_UPGRADE_COSTS.length). */
const MAX_BASE_LEVEL = BASE_UPGRADE_COSTS.length;

/** Edit target: defend a tile / edit an attack team (G3-2c). */
export type DefenseEditorTarget =
  | { mode: 'defense'; tileKey: string }
  | { mode: 'attack'; teamId: string; teamName: string };

export interface DefenseEditorCallbacks {
  onBack(): void;
  worldApi: WorldApiClient;
  worldId: string;
  target: DefenseEditorTarget;
  /** Current authoritative save (for cardInv roster). Attack mode only. */
  getSave?(): SaveData;
}

// ── Collected pool (U8) ───────────────────────────────────────────────────────
// Only unit/building types from card definitions = the player's "collected" placeable set; preserves card table order.

function distinctCollected<T extends string>(pick: (c: typeof CARD_DEFINITIONS[number]) => T | undefined): T[] {
  const out: T[] = [];
  for (const card of CARD_DEFINITIONS) {
    const v = pick(card);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const COLLECTED_UNITS = distinctCollected((c) =>
  c.cardType === CardType.Unit ? (c.unitType as UnitType | undefined) : undefined);
const COLLECTED_BUILDINGS = distinctCollected((c) =>
  c.cardType === CardType.Building ? (c.buildingType as BuildingType | undefined) : undefined);

/** First card display-name key for a given unit/building type (label reuse, no new keys). */
function nameKeyFor(kind: 'unit' | 'building', type: string): TranslationKey {
  for (const card of CARD_DEFINITIONS) {
    if (kind === 'unit' && card.unitType === type) return card.nameKey as TranslationKey;
    if (kind === 'building' && card.buildingType === type) return card.nameKey as TranslationKey;
  }
  return 'world.defense.title';
}

// ── Tools ──────────────────────────────────────────────────────────────────────

type Tool =
  | { kind: 'unit'; type: UnitType }
  | { kind: 'building'; type: BuildingType }
  | { kind: 'card'; cardInstanceId: string; unitType: UnitType }
  | { kind: 'erase' };

// Defender deployment zone shown top→bottom: building row first, then garrison rows
// 16..9 (defender's own half). Garrison schema allows rows 1..16; we expose the back
// half which is where a defender realistically forts up — keeps the grid mobile-sized.
const DEFENSE_ROWS = [16, 15, 14, 13, 12, 11, 10, 9] as const;
// Attacker (Bottom) half shown top→bottom: rows 8..1 (1 = home spawn row at the bottom).
const ATTACK_ROWS = [8, 7, 6, 5, 4, 3, 2, 1] as const;

const MAX_GARRISON = 30;

/**
 * hp: defense-mode blueprint HP allocation; attack-mode current cardState troop count (display cache,
 * refreshed from this.cardState on each render via committedTroops()/drawUnit — see cardInstanceId).
 */
type GarrisonEntry = { unitType: UnitType; hp: number; cardInstanceId?: string };

// ── Caps / layout ────────────────────────────────────────────────────────────

const PALETTE_H = 54;
const FOOTER_H = 58;
const PAD = 10;

// ── Scene ───────────────────────────────────────────────────────────────────────

export class DefenseEditorScene implements Scene {
  readonly container: PIXI.Container;

  private readonly w: number;
  private readonly h: number;
  private readonly cb: DefenseEditorCallbacks;

  // Mode-derived layout (G3-2c)
  private readonly mode: 'defense' | 'attack';
  private readonly gRows: readonly number[];      // garrison/army rows shown (top→bottom)
  private readonly hasBuildingRow: boolean;        // defense only: building row + base level

  // Config state
  private buildings = new Map<number, BuildingType>();        // col → building (building row)
  private garrison = new Map<string, GarrisonEntry>();        // "col:row" → { unitType, hp }
  private baseLevel = 0;
  // Attack mode: the full team list (loaded once) so save merges this slot without clobbering others.
  private teams: TeamTemplate[] = [];
  // Attack mode: this account's live card ledger (troops/injury/teamId), fetched alongside teams.
  private cardState: Record<string, CardSLGState> = {};
  // Attack mode: the unified base troop pool (playerWorld.troops) available to distribute to this team's
  // cards (CHARACTER_CARDS_DESIGN §6.3/§6.5). Trained on the home desk's Train Troops tile.
  private troops = 0;
  private tool: Tool = { kind: 'erase' };
  // Attack mode: the placed-card cell ("col:row") currently selected for per-card troop allocation
  // (tapping a placed card opens its allocate stepper). Null = no card selected / stepper hidden.
  private selectedCell: string | null = null;
  private loading = true;
  private saving = false;
  private filling = false;
  private destroyed = false;

  // Attack mode: right-half card roster is a scrollable vertical grid (left half = formation grid).
  // Same tap-vs-drag disambiguation as TeamsScene's roster grid — see ScrollTapGesture.
  private scrollY = 0;
  private scrollMax = 0;
  private scrollDirty = false;
  private readonly gesture = new ScrollTapGesture();
  private rosterX = 0;
  private rosterY = 0;
  private rosterW = 0;
  private rosterH = 0;
  private readonly artHooked = new Set<string>();

  // Layers
  private bodyLayer!: PIXI.Container;

  // Hit rects (rebuilt each render)
  private hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];

  // Grid geometry (computed in render)
  private gridX = 0;
  private gridY = 0;
  private cellW = 0;
  private cellH = 0;

  private readonly unsubs: (() => void)[] = [];

  constructor(layout: ILayout, input: InputManager, cb: DefenseEditorCallbacks) {
    this.w = layout.designWidth;
    this.h = layout.designHeight;
    this.cb = cb;
    this.mode = cb.target.mode;
    this.gRows = this.mode === 'attack' ? ATTACK_ROWS : DEFENSE_ROWS;
    this.hasBuildingRow = this.mode === 'defense';
    // Attack mode: no default tool — the roster loads async, so start on erase until the player taps a card.
    this.container = new PIXI.Container();

    const bg = buildPaperBackground('defense', this.w, this.h);
    this.container.addChild(bg);
    const decoC = buildDecorCLayer(this.w, this.h);
    if (decoC) this.container.addChild(decoC);
    this.bodyLayer = new PIXI.Container();
    this.container.addChild(this.bodyLayer);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((_x, y) => this.handleMove(y)));
    this.unsubs.push(input.onUp(() => this.handleUp()));

    this.render();
    void this.loadData();
  }

  // ── Data ──────────────────────────────────────────────────────────────────

  private async loadData(): Promise<void> {
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
          if (team) this.applyArmy(team.army);
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
  private applyArmy(army: ArmyEntry[]): void {
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
  private applyConfig(cfg: Record<string, unknown>): void {
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
  private buildArmy(): ArmyEntry[] {
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
  private async persistTeam(): Promise<void> {
    if (this.cb.target.mode !== 'attack') return;
    const { teamId, teamName } = this.cb.target;
    const army = this.buildArmy();
    const next = this.teams.filter((tm) => tm.id !== teamId);
    next.push({ id: teamId, name: teamName, army });
    await this.cb.worldApi.setTeams(this.cb.worldId, next);
    this.teams = next;
  }

  private async doSave(): Promise<void> {
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
    }
  }

  /**
   * §6.5 一键补满: distribute the base troop pool to this formation's placed cards, highest combat-power
   * first, up to each card's troopCap. Per-card manual adjustment is available via the tap-a-cell stepper
   * (allocateToCard) — this one-tap button just fills them all by power priority.
   */
  private async doFillTroops(): Promise<void> {
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

  private errorMsg(e: unknown): string {
    if (e instanceof WorldApiError) {
      if (e.code === 'TILE_NOT_OWNED') return t('world.err.notOwner');
      return e.message;
    }
    return t('world.defense.saveFail');
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /** Scene title: team name (attack) / home base or tile (defense). */
  private titleText(): string {
    return this.cb.target.mode === 'attack'
      ? t('world.team.editTitle').replace('{name}', this.cb.target.teamName)
      : this.cb.target.tileKey === 'base'
        ? t('world.defense.titleBase')
        : t('world.defense.titleTile').replace('{tile}', this.cb.target.tileKey);
  }

  private render(): void {
    tearDownChildren(this.bodyLayer);
    this.hits = [];
    const { w, h } = this;

    // Header: back + title + base-level stepper (drawn on the right slot below)
    const hdr = drawSceneHeader(this.bodyLayer, w, this.h, this.titleText(), {
      variant: 'paper', accent: HEADER_ACCENT.slg,
    });
    this.hits.push({ rect: hdr.backRect, action: () => this.cb.onBack() });

    // Base-level stepper (defense only — attacker has no base/buildings)
    if (this.hasBuildingRow) this.renderBaseStepper(w - PAD, 8);
    // Attack mode: the troop readout (top-left) + Fill/Clear/Save (top-right) live in the header's
    // free space instead of a bottom footer, so the whole footer band goes to the grid + roster
    // (2026-07-22, user request "move these two up top").
    if (this.mode === 'attack') this.renderAttackHeaderControls(hdr.headerH);

    // Attack mode has no bottom footer (controls moved into the header); defense keeps it.
    const footerH = this.mode === 'attack' ? 0 : FOOTER_H;
    const gridBottom = h - footerH - 4;
    if (this.mode === 'attack') {
      // Left half = formation grid, right half = scrollable card roster (布阵/选卡 split).
      this.renderAttackBody(hdr.headerH + 4, gridBottom);
    } else {
      this.renderPalette(hdr.headerH + 4);
      const gridTop = hdr.headerH + 4 + PALETTE_H + 4;
      this.renderGrid(gridTop, gridBottom);
    }

    // Footer: counts + clear + save (defense only)
    if (this.mode !== 'attack') this.renderFooter(h - FOOTER_H);

    // Per-card allocate stepper overlay (attack mode) — shown for the currently selected placed card.
    // With no footer it anchors to the screen bottom.
    if (this.mode === 'attack' && this.selectedCell) {
      const entry = this.garrison.get(this.selectedCell);
      if (entry?.cardInstanceId) this.renderAllocateStepper(entry.cardInstanceId, h);
      else this.selectedCell = null;
    }

    if (this.loading) {
      const lbl = txt(t('world.loading'), FS.tiny, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2;
      this.bodyLayer.addChild(lbl);
    }
  }

  private renderBaseStepper(rightX: number, y: number): void {
    const btnW = 24, btnH = 24;
    const lbl = txt(t('world.defense.baseLevel').replace('{lv}', String(this.baseLevel)), FS.micro, C.dark);
    // [-] label [+] laid right-aligned
    const plus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y, btnW) });
    plus.x = rightX - btnW; plus.y = y;
    this.bodyLayer.addChild(plus);
    const plusLbl = txt('+', FS.small, C.light); plusLbl.anchor.set(0.5, 0.5);
    plusLbl.x = plus.x + btnW / 2; plusLbl.y = plus.y + btnH / 2;
    this.bodyLayer.addChild(plusLbl);
    this.hits.push({ rect: { x: plus.x, y: plus.y, w: btnW, h: btnH }, action: () => {
      this.baseLevel = Math.min(MAX_BASE_LEVEL, this.baseLevel + 1); this.render();
    } });

    lbl.anchor.set(1, 0.5);
    lbl.x = plus.x - 6; lbl.y = y + btnH / 2;
    this.bodyLayer.addChild(lbl);

    const minus = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightX, y + 1, btnW) });
    minus.x = lbl.x - lbl.width - 6 - btnW; minus.y = y;
    this.bodyLayer.addChild(minus);
    const minusLbl = txt('−', FS.small, C.light); minusLbl.anchor.set(0.5, 0.5);
    minusLbl.x = minus.x + btnW / 2; minusLbl.y = minus.y + btnH / 2;
    this.bodyLayer.addChild(minusLbl);
    this.hits.push({ rect: { x: minus.x, y: minus.y, w: btnW, h: btnH }, action: () => {
      this.baseLevel = Math.max(0, this.baseLevel - 1); this.render();
    } });
  }

  private renderPalette(top: number): void {
    const { w } = this;
    const tools: { tool: Tool; label: string; tint: number }[] = [
      // Buildings are defense-mode only (attacker places units only).
      ...(this.hasBuildingRow ? COLLECTED_BUILDINGS.map((bt) => ({
        tool: { kind: 'building', type: bt } as Tool, label: t(nameKeyFor('building', bt)), tint: C.gold,
      })) : []),
      ...COLLECTED_UNITS.map((ut) => ({
        tool: { kind: 'unit', type: ut } as Tool, label: t(nameKeyFor('unit', ut)), tint: C.accent,
      })),
      { tool: { kind: 'erase' } as Tool, label: t('world.defense.erase'), tint: C.red },
    ];
    const n = tools.length;
    const gap = 5;
    const btnW = (w - PAD * 2 - gap * (n - 1)) / n;
    const btnH = PALETTE_H - 10;
    let x = PAD;
    for (const { tool, label, tint } of tools) {
      const active = this.toolEquals(tool, this.tool);
      const box = sketchPanel(btnW, btnH, {
        fill: active ? tint : C.paper, border: active ? C.dark : tint,
        width: active ? 2.4 : 1.4, seed: seedFor(x, top, btnW),
      });
      box.x = x; box.y = top + 5;
      this.bodyLayer.addChild(box);
      const lbl = txt(label, FS.micro, active ? C.light : C.dark, true);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = x + btnW / 2; lbl.y = top + 5 + btnH / 2;
      this.bodyLayer.addChild(lbl);
      const captured = tool;
      this.hits.push({ rect: { x, y: top + 5, w: btnW, h: btnH }, action: () => {
        this.tool = captured; this.render();
      } });
      x += btnW + gap;
    }
  }

  private toolEquals(a: Tool, b: Tool): boolean {
    if (a.kind !== b.kind) return false;
    if (a.kind === 'erase' || b.kind === 'erase') return a.kind === b.kind;
    if (a.kind === 'card' && b.kind === 'card') return a.cardInstanceId === b.cardInstanceId;
    return (a as { type: string }).type === (b as { type: string }).type;
  }

  /**
   * Roster cards eligible for this team: not injured, and not already committed to a *different*
   * team slot (a card on this same slot is fine — it's already reflected in this.garrison and shows
   * as placed). Mirrors TeamsScene's card-availability rules (CHARACTER_CARDS_DESIGN §8).
   */
  private availableCards(): { card: CardInstance; unitType: UnitType; troops: number; cap: number }[] {
    const cardInv = this.cb.getSave?.().cardInv ?? {};
    const myTeamId = this.mode === 'attack' ? (this.cb.target as { teamId: string }).teamId : undefined;
    const now = Date.now();
    const out: { card: CardInstance; unitType: UnitType; troops: number; cap: number }[] = [];
    for (const card of Object.values(cardInv)) {
      const def = CARD_DEFS[card.defId];
      if (!def) continue;
      const st = this.cardState[card.id];
      if ((st?.injuredUntil ?? 0) > now) continue;
      if (st?.teamId && st.teamId !== myTeamId) continue;
      out.push({ card, unitType: def.unitType as UnitType, troops: st?.currentTroops ?? 0, cap: troopCap(card) });
    }
    return out;
  }

  /** Which cell (if any) a given card is currently placed at, in this in-progress edit. */
  private cellForCard(cardInstanceId: string): string | undefined {
    for (const [key, entry] of this.garrison) if (entry.cardInstanceId === cardInstanceId) return key;
    return undefined;
  }

  /** Per-card troop cap (statistics-derived) for a placed card instance; 0 if the card is no longer owned. */
  private capForCard(cardInstanceId: string): number {
    const card = this.cb.getSave?.().cardInv?.[cardInstanceId];
    return card ? troopCap(card) : 0;
  }

  /**
   * Per-card 分兵: add `requested` troops from the base pool to one placed card (server distributeTroops
   * is add-only — troops committed to a card are only released by removing the card from the team, §6.1).
   * Amount is clamped to min(requested, troopCap gap, pool). Persists the team first (so the card has a
   * server teamId), then distributes and mirrors local state — same order/rules as doFillTroops.
   */
  private async allocateToCard(cardInstanceId: string, requested: number): Promise<void> {
    if (this.filling || this.cb.target.mode !== 'attack') return;
    const card = this.cb.getSave?.().cardInv?.[cardInstanceId];
    if (!card) return;
    const current = this.cardState[cardInstanceId]?.currentTroops ?? 0;
    const gap = Math.max(0, troopCap(card) - current);
    const amount = Math.min(requested, gap, this.troops);
    if (amount <= 0) {
      this.showToast(gap <= 0 ? t('world.team.cardFull') : t('world.team.fillNone'), C.red);
      return;
    }
    this.filling = true;
    try {
      await this.persistTeam();
      await this.cb.worldApi.distributeTroops(this.cb.worldId, { [cardInstanceId]: amount });
      const cs = this.cardState[cardInstanceId];
      const nextTroops = current + amount;
      this.cardState[cardInstanceId] = { ...cs, currentTroops: nextTroops };
      const entry = [...this.garrison.values()].find((e) => e.cardInstanceId === cardInstanceId);
      if (entry) entry.hp = nextTroops;
      this.troops -= amount;
      this.showToast(t('world.team.fillDone').replace('{n}', String(amount)));
    } catch (e) {
      this.showToast(this.errorMsg(e), C.red);
    }
    this.filling = false;
    this.render();
  }

  /**
   * Attack mode body: left half = formation grid (place cards into cells), right half = a scrollable
   * vertical card roster to pick from — mirrors 布阵(left)/选卡(right) so both stay visible together
   * instead of the old horizontal palette strip forcing a page-flip to see more cards.
   */
  private renderAttackBody(top: number, bottom: number): void {
    const { w } = this;
    const gap = PAD;
    const leftW = Math.floor((w - PAD * 2 - gap) / 2);
    const rightX = PAD + leftW + gap;
    const rightW = w - PAD - rightX;

    const toolbarH = 30;
    this.renderAttackToolbar(PAD, top, leftW, toolbarH);
    this.renderGrid(top + toolbarH + 6, bottom, PAD, leftW);

    this.rosterX = rightX; this.rosterY = top; this.rosterW = rightW; this.rosterH = bottom - top;
    this.renderCardRosterPanel(rightX, top, rightW, bottom - top);
  }

  /** Hint text + erase toggle, sized to the left (grid) half only. */
  private renderAttackToolbar(x: number, y: number, w: number, h: number): void {
    const hint = txt(t('world.team.hint'), FS.micro, C.mid);
    hint.anchor.set(0, 0.5);
    hint.x = x; hint.y = y + h / 2;
    if (hint.width > w - 66) hint.scale.set((w - 66) / hint.width);
    this.bodyLayer.addChild(hint);

    const eraseW = 60, eraseH = h - 6;
    const eraseActive = this.tool.kind === 'erase';
    const eraseX = x + w - eraseW;
    const box = sketchPanel(eraseW, eraseH, {
      fill: eraseActive ? C.red : C.paper, border: eraseActive ? C.dark : C.red,
      width: eraseActive ? 2.4 : 1.4, seed: seedFor(eraseX, y, eraseW),
    });
    box.x = eraseX; box.y = y + 3;
    this.bodyLayer.addChild(box);
    const lbl = txt(t('world.defense.erase'), FS.micro, eraseActive ? C.light : C.red, true);
    lbl.anchor.set(0.5, 0.5); lbl.x = box.x + eraseW / 2; lbl.y = box.y + eraseH / 2;
    this.bodyLayer.addChild(lbl);
    this.hits.push({ rect: { x: box.x, y: box.y, w: eraseW, h: eraseH }, action: () => { this.tool = { kind: 'erase' }; this.render(); } });
  }

  /** Right-half card roster: a scrollable portrait-card grid (mirrors TeamsScene's roster grid). */
  private renderCardRosterPanel(x: number, y: number, w: number, h: number): void {
    const cards = this.availableCards();
    const titleH = 22;
    const title = txt(t('roster.title'), FS.micro, C.mid);
    title.x = x; title.y = y + 2;
    this.bodyLayer.addChild(title);

    const listY = y + titleH;
    const availH = h - titleH;
    if (cards.length === 0) {
      const empty = txt(t('world.team.noCards'), FS.micro, C.mid);
      empty.x = x; empty.y = listY + 8;
      this.bodyLayer.addChild(empty);
      this.scrollMax = 0;
      return;
    }

    const gap = 8;
    const cellWTarget = 168, cellH = 96;
    const cols = Math.max(1, Math.floor((w + gap) / (cellWTarget + gap)));
    const cellW = (w - gap * (cols - 1)) / cols;
    const rows = Math.ceil(cards.length / cols);
    const totalH = rows * (cellH + gap) + gap;
    // Pull the visible viewport in so a partial next row always peeks above the fold (see scrollPeek).
    const listH = peekViewportH(availH, cellH + gap, totalH);
    this.scrollMax = Math.max(0, totalH - listH);
    this.scrollY = Math.max(0, Math.min(this.scrollY, this.scrollMax));

    cards.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = x + col * (cellW + gap);
      const cy = listY + gap + row * (cellH + gap) - this.scrollY;
      if (cy + cellH >= listY && cy <= listY + listH) this.renderRosterCell(c, cx, cy, cellW, cellH);
    });

    drawScrollIndicator(this.bodyLayer, { x, y: listY, w, h: listH }, this.scrollY, this.scrollMax);
  }

  private renderRosterCell(
    c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
    x: number, y: number, cellW: number, cellH: number,
  ): void {
    const active = this.tool.kind === 'card' && this.tool.cardInstanceId === c.card.id;
    const placed = this.cellForCard(c.card.id) !== undefined;
    const pad = 6;
    const box = sketchPanel(cellW, cellH, {
      fill: active ? C.accent : 0xfaf9f5, border: active ? C.dark : (placed ? C.accent : C.mid),
      width: active ? 2.4 : 1.4, seed: seedFor(x, y, cellW),
    });
    box.x = x; box.y = y;
    this.bodyLayer.addChild(box);

    const imgH = cellH - pad * 2;
    const imgW = Math.round(imgH * 0.72);
    const frame = sketchPanel(imgW, imgH, { fill: 0xf0eee7, border: C.mid, seed: seedFor(x, y, imgW) });
    frame.x = x + pad; frame.y = y + pad;
    this.bodyLayer.addChild(frame);
    const artUrl = UNIT_ART_URLS[c.unitType];
    if (artUrl) this.drawArtFit(artUrl, x + pad + 1, y + pad + 1, imgW - 2, imgH - 2);

    const ax = x + pad + imgW + 8;
    const rightW = Math.max(10, x + cellW - pad - ax);
    const name = t(`card.${c.card.defId}.name` as import('../i18n').TranslationKey);
    const nameLbl = txt(`${name} Lv.${c.card.level}`, FS.micro, active ? C.light : C.dark, true);
    nameLbl.x = ax; nameLbl.y = y + pad;
    if (nameLbl.width > rightW) nameLbl.scale.set(Math.max(0.5, rightW / nameLbl.width));
    this.bodyLayer.addChild(nameLbl);

    const troopLbl = txt(`${c.troops}/${c.cap}`, FS.micro, active ? C.light : C.mid);
    troopLbl.x = ax; troopLbl.y = y + pad + 18;
    this.bodyLayer.addChild(troopLbl);

    if (placed) {
      const tag = txt(`[${t('roster.inTeam')}]`, FS.micro, active ? C.light : C.accent, true);
      tag.x = ax; tag.y = y + pad + 36;
      this.bodyLayer.addChild(tag);
    }

    this.hits.push({ rect: { x, y, w: cellW, h: cellH }, action: () => {
      this.tool = { kind: 'card', cardInstanceId: c.card.id, unitType: c.unitType };
      this.render();
    } });
  }

  /** Draw a unit portrait fit into a box, centered; re-render once its texture loads (mirrors TeamsScene). */
  private drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void {
    const tex = getArtTexture(url);
    if (!tex.baseTexture.valid) {
      if (!this.artHooked.has(url)) {
        this.artHooked.add(url);
        tex.baseTexture.once('loaded', () => { if (!this.destroyed) this.render(); });
      }
      return;
    }
    const scale = Math.min(boxW / tex.width, boxH / tex.height);
    const sp = new PIXI.Sprite(tex);
    sp.anchor.set(0.5);
    sp.scale.set(scale);
    sp.position.set(x + boxW / 2, y + boxH / 2);
    this.bodyLayer.addChild(sp);
  }

  private renderGrid(top: number, bottom: number, areaX: number = PAD, areaW: number = this.w - PAD * 2): void {
    const buildRows = this.hasBuildingRow ? 1 : 0;
    const rows = buildRows + this.gRows.length; // (defense: building row +) garrison rows
    const availW = areaW;
    const availH = bottom - top;
    const cellW = availW / 12;
    const cellH = Math.min(cellW, availH / rows);
    const gridW = cellW * 12;
    const gridH = cellH * rows;
    const gridX = areaX + (areaW - gridW) / 2;
    const gridY = top + (availH - gridH) / 2;
    this.gridX = gridX; this.gridY = gridY; this.cellW = cellW; this.cellH = cellH;

    const g = new PIXI.Graphics();
    this.bodyLayer.addChild(g);

    const attackSet = new Set<number>(ATTACK_LANES as readonly number[]);
    const [baseLo, baseHi] = BASE_COLS;

    // Display rows: (defense only) dr 0 = building row; remaining = this.gRows
    for (let dr = 0; dr < rows; dr++) {
      const isBuildingRow = this.hasBuildingRow && dr === 0;
      const py = gridY + dr * cellH;
      for (let col = 0; col < 12; col++) {
        const px = gridX + col * cellW;
        const isBaseCol = col >= baseLo && col <= baseHi;
        const isAttack = attackSet.has(col);

        // Cell background
        let fill = 0xf2ece0;
        if (isBaseCol) fill = isBuildingRow ? 0xd9b3b3 : 0xe6dccb; // base column tint
        g.beginFill(fill, 0.85);
        g.lineStyle(0.6, 0xc8bba8, 0.7);
        g.drawRect(px + 0.5, py + 0.5, cellW - 1, cellH - 1);
        g.endFill();

        // Content
        if (isBuildingRow) {
          if (isBaseCol && col === baseLo) {
            g.beginFill(0xcc3333, 0.5);
            g.drawRect(px + 2, py + 2, cellW * 2 - 4, cellH - 4);
            g.endFill();
          }
          if (isAttack) {
            const b = this.buildings.get(col);
            if (b) this.drawBuilding(g, px, py, cellW, cellH, b);
          }
        } else {
          const row = this.gRows[dr - buildRows]!;
          if (isAttack) {
            const key = `${col}:${row}`;
            const u = this.garrison.get(key);
            if (u) {
              const cap = this.mode === 'attack' && u.cardInstanceId ? this.capForCard(u.cardInstanceId) : undefined;
              this.drawUnit(g, px, py, cellW, cellH, u.unitType, u.hp, cap, key === this.selectedCell);
            }
          }
        }
      }
    }

    // Row label (left): defense → building row; attack → spawn row at the home row (bottom).
    const lbl = txt(this.hasBuildingRow ? t('world.defense.buildRow') : t('world.team.frontRow'), FS.micro, C.mid);
    lbl.anchor.set(1, 0.5);
    lbl.x = gridX - 3;
    lbl.y = this.hasBuildingRow ? gridY + cellH / 2 : gridY + (rows - 0.5) * cellH;
    this.bodyLayer.addChild(lbl);
  }

  private drawBuilding(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: BuildingType): void {
    const cx = px + cw / 2, cy = py + ch / 2;
    const r = Math.min(cw, ch) * 0.32;
    if (type === BuildingType.ArrowTower) {
      g.lineStyle(1.5, 0x6a5a20, 1);
      g.beginFill(C.gold, 0.9);
      // triangle (tower)
      g.drawPolygon([cx, cy - r, cx + r, cy + r, cx - r, cy + r]);
      g.endFill();
    } else {
      g.lineStyle(1.5, 0x6a5a20, 1);
      g.beginFill(0xcc9900, 0.85);
      g.drawRect(cx - r, cy - r, r * 2, r * 2); // square (barracks)
      g.endFill();
    }
  }

  private drawUnit(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: UnitType, hp?: number, cap?: number, selected = false): void {
    const cx = px + cw / 2, cy = py + ch / 2;
    const size = Math.min(cw, ch) * 0.72;
    const bx = cx - size / 2, by = cy - size / 2;
    const artUrl = UNIT_ART_URLS[type];
    if (artUrl) {
      const frame = sketchPanel(size, size, {
        fill: 0xf0eee7, border: selected ? C.gold : 0x33425a, width: selected ? 2.4 : 1.2, seed: seedFor(px, py, size),
      });
      frame.x = bx; frame.y = by;
      this.bodyLayer.addChild(frame);
      this.drawArtFit(artUrl, bx + 1, by + 1, size - 2, size - 2);
    } else {
      const r = size / 2;
      g.lineStyle(selected ? 2.4 : 1.2, selected ? C.gold : 0x33425a, 1);
      g.beginFill(0x4477cc, 0.92);
      g.drawCircle(cx, cy, r);
      g.endFill();
    }

    // Attack mode: a troop bar above the head showing currentTroops / troopCap(card), green→amber→red by
    // fill ratio, so at-a-glance you see how many soldiers each on-field character carries.
    if (hp !== undefined && this.mode === 'attack' && cap && cap > 0) {
      const ratio = Math.max(0, Math.min(1, hp / cap));
      const barW = size, barH = 3, byBar = by - barH - 1;
      const barColor = ratio >= 0.66 ? 0x4caf50 : ratio >= 0.33 ? 0xe0a020 : 0xcc3b3b;
      g.beginFill(0x000000, 0.28);
      g.drawRect(bx, byBar, barW, barH);
      g.endFill();
      g.beginFill(barColor, 1);
      g.drawRect(bx, byBar, barW * ratio, barH);
      g.endFill();
    }

    // Live troop count under the icon — a card's cardState ledger, not a blueprint-relative HP fraction
    // (a card's troop count isn't bounded by the unit's base HP stat).
    if (hp !== undefined && this.mode === 'attack') {
      const label = txt(String(hp), FS.micro, 0x222222, true);
      label.anchor.set(0.5, 0);
      label.x = cx; label.y = by + size + 1;
      this.bodyLayer.addChild(label);
    }
  }

  /** Defense footer: counts + hint on the left, action buttons on the right. (Attack mode has no footer.) */
  private renderFooter(top: number): void {
    const { w } = this;
    const panel = sketchPanel(w, FOOTER_H, { fill: C.paper, border: C.mid, seed: seedFor(0, top, w) });
    panel.y = top;
    this.bodyLayer.addChild(panel);

    const countsStr = `${t('world.defense.buildings')} ${this.buildings.size}   ${t('world.defense.garrison').replace('{n}', String(this.garrison.size))}`;
    const counts = txt(countsStr, FS.micro, C.dark);
    counts.x = PAD; counts.y = top + 8;
    this.bodyLayer.addChild(counts);

    const hint = txt(t('world.defense.hint'), FS.micro, C.mid);
    hint.x = PAD; hint.y = top + 26;
    this.bodyLayer.addChild(hint);

    this.renderActionButtons(w - PAD, top, FOOTER_H);
  }

  /**
   * Attack-mode header controls: the troop readout (garrison / committed / pool) at the top-left
   * (right of the back pill, scaled to clear the centred title) + the Fill/Clear/Save cluster at the
   * top-right — both drawn over the baked header chrome so the bottom footer band frees up entirely.
   */
  private renderAttackHeaderControls(headerH: number): void {
    const { w } = this;
    const countsStr = `${t('world.defense.garrison').replace('{n}', String(this.garrison.size))}   ${t('world.team.committed').replace('{n}', String(this.committedTroops()))}   ${t('world.team.pool').replace('{n}', String(this.troops))}`;
    const counts = txt(countsStr, FS.small, C.dark, true);
    counts.anchor.set(0, 0.5);
    const startX = 210; // clears the back pill (constant width in the shared 1080 design space)
    counts.x = startX; counts.y = headerH / 2;
    // Keep clear of the horizontally-centred title (measure it to find its left edge).
    const titleNode = txt(this.titleText(), FS.headline, C.dark, true);
    const titleLeft = w / 2 - titleNode.width / 2;
    titleNode.destroy({ texture: true, baseTexture: true });
    const avail = titleLeft - 12 - startX;
    if (avail > 20 && counts.width > avail) counts.scale.set(avail / counts.width);
    this.bodyLayer.addChild(counts);

    this.renderActionButtons(w - PAD, 0, headerH);
  }

  /**
   * Right-aligned Fill troops (attack only) / Clear / Save cluster, vertically centred on the band
   * [top, top+rowH] ending at `rightEdge`. Shared by the defense footer and the attack header.
   */
  private renderActionButtons(rightEdge: number, top: number, rowH: number): void {
    const btnW = 70, btnH = 30;
    const cy = top + (rowH - btnH) / 2;
    const save = sketchPanel(btnW, btnH, { fill: C.dark, border: C.gold, seed: seedFor(rightEdge, top, btnW) });
    save.x = rightEdge - btnW; save.y = cy;
    this.bodyLayer.addChild(save);
    const saveLbl = txt(t('world.defense.save'), FS.tiny, C.light, true);
    saveLbl.anchor.set(0.5, 0.5);
    saveLbl.x = save.x + btnW / 2; saveLbl.y = save.y + btnH / 2;
    this.bodyLayer.addChild(saveLbl);
    this.hits.push({ rect: { x: save.x, y: save.y, w: btnW, h: btnH }, action: () => void this.doSave() });

    const clear = sketchPanel(btnW, btnH, { fill: C.paper, border: C.red, seed: seedFor(rightEdge, top + 1, btnW) });
    clear.x = save.x - btnW - 8; clear.y = cy;
    this.bodyLayer.addChild(clear);

    if (this.mode === 'attack') {
      const fillW = 84;
      const fill = sketchPanel(fillW, btnH, { fill: C.paper, border: C.gold, seed: seedFor(rightEdge, top + 2, fillW) });
      fill.x = clear.x - fillW - 8; fill.y = cy;
      this.bodyLayer.addChild(fill);
      const fillLbl = txt(t('world.team.fill'), FS.tiny, C.dark, true);
      fillLbl.anchor.set(0.5, 0.5);
      fillLbl.x = fill.x + fillW / 2; fillLbl.y = fill.y + btnH / 2;
      if (fillLbl.width > fillW - 6) fillLbl.scale.set((fillW - 6) / fillLbl.width);
      this.bodyLayer.addChild(fillLbl);
      this.hits.push({ rect: { x: fill.x, y: fill.y, w: fillW, h: btnH }, action: () => void this.doFillTroops() });
    }
    const clearLbl = txt(t('world.defense.clear'), FS.tiny, C.red, true);
    clearLbl.anchor.set(0.5, 0.5);
    clearLbl.x = clear.x + btnW / 2; clearLbl.y = clear.y + btnH / 2;
    this.bodyLayer.addChild(clearLbl);
    this.hits.push({ rect: { x: clear.x, y: clear.y, w: btnW, h: btnH }, action: () => {
      this.buildings.clear(); this.garrison.clear(); this.baseLevel = 0; this.selectedCell = null; this.render();
    } });
  }

  /**
   * Per-card allocate stepper (attack mode): a bar just above the footer for the selected placed card,
   * showing name + currentTroops/troopCap + a set of add presets (+100 / +500 / 补满此卡) drawing from the
   * base pool, plus a close ✕. Add-only (server distributeTroops cannot pull troops back off a card).
   */
  private renderAllocateStepper(cardInstanceId: string, footerTop: number): void {
    const { w } = this;
    const card = this.cb.getSave?.().cardInv?.[cardInstanceId];
    if (!card) { this.selectedCell = null; return; }
    const cur = this.cardState[cardInstanceId]?.currentTroops ?? 0;
    const cap = troopCap(card);
    const barH = 40;
    const top = footerTop - barH - 2;

    const panel = sketchPanel(w, barH, { fill: 0xfaf7ef, border: C.gold, width: 1.6, seed: seedFor(0, top, w) });
    panel.y = top;
    this.bodyLayer.addChild(panel);

    const name = t(`card.${card.defId}.name` as TranslationKey);
    const info = txt(`${name}  ${cur}/${cap}   ${t('world.team.pool').replace('{n}', String(this.troops))}`, FS.micro, C.dark, true);
    info.x = PAD; info.y = top + (barH - 14) / 2;
    if (info.width > w * 0.5) info.scale.set((w * 0.5) / info.width);
    this.bodyLayer.addChild(info);

    // Right-aligned: [close] [补满此卡] [+500] [+100]
    const btnH = 28, gap = 6;
    let rx = w - PAD;
    const addBtn = (label: string, wdt: number, tint: number, fg: number, action: () => void) => {
      rx -= wdt;
      const b = sketchPanel(wdt, btnH, { fill: tint, border: C.dark, seed: seedFor(rx, top, wdt) });
      b.x = rx; b.y = top + (barH - btnH) / 2;
      this.bodyLayer.addChild(b);
      const l = txt(label, FS.micro, fg, true);
      l.anchor.set(0.5, 0.5); l.x = rx + wdt / 2; l.y = b.y + btnH / 2;
      if (l.width > wdt - 6) l.scale.set((wdt - 6) / l.width);
      this.bodyLayer.addChild(l);
      this.hits.push({ rect: { x: rx, y: b.y, w: wdt, h: btnH }, action });
      rx -= gap;
    };
    addBtn('✕', 26, C.paper, C.mid, () => { this.selectedCell = null; this.render(); });
    addBtn(t('world.team.cardFill'), 84, C.gold, C.dark, () => void this.allocateToCard(cardInstanceId, cap - cur));
    addBtn('+500', 54, C.paper, C.dark, () => void this.allocateToCard(cardInstanceId, 500));
    addBtn('+100', 54, C.paper, C.dark, () => void this.allocateToCard(cardInstanceId, 100));
  }

  /** Attacker army committed troops = sum of each placed card's live cardState.currentTroops (consistent with TeamsScene / server). */
  private committedTroops(): number {
    let sum = 0;
    for (const entry of this.garrison.values()) {
      sum += entry.cardInstanceId ? (this.cardState[entry.cardInstanceId]?.currentTroops ?? 0) : entry.hp;
    }
    return sum;
  }

  // ── Cell placement ───────────────────────────────────────────────────────────

  private onGridTap(sx: number, sy: number): void {
    if (this.cellW <= 0) return;
    const col = Math.floor((sx - this.gridX) / this.cellW);
    const dr = Math.floor((sy - this.gridY) / this.cellH);
    const buildRows = this.hasBuildingRow ? 1 : 0;
    const rows = buildRows + this.gRows.length;
    if (col < 0 || col > 11 || dr < 0 || dr >= rows) return;
    if (!(ATTACK_LANES as readonly number[]).includes(col)) {
      this.showToast(t('world.defense.baseColBlocked'), C.red);
      return;
    }

    if (this.hasBuildingRow && dr === 0) {
      // Building row (defense only)
      if (this.tool.kind === 'erase') {
        this.buildings.delete(col);
      } else if (this.tool.kind === 'building') {
        this.buildings.set(col, this.tool.type);
      } else {
        this.showToast(t('world.defense.unitsNotHere'), C.red);
        return;
      }
    } else {
      // Garrison / army row
      const row = this.gRows[dr - buildRows]!;
      const key = `${col}:${row}`;
      if (this.tool.kind === 'erase') {
        this.garrison.delete(key);
        if (this.selectedCell === key) this.selectedCell = null;
      } else if (this.mode === 'attack' && this.tool.kind === 'card') {
        const { cardInstanceId, unitType } = this.tool;
        const occupant = this.garrison.get(key);
        // Tapping a cell held by a DIFFERENT placed card selects THAT card for troop allocation rather
        // than clobbering it (safe — no accidental overwrite of another placed card).
        if (occupant?.cardInstanceId && occupant.cardInstanceId !== cardInstanceId) {
          this.selectedCell = key;
        } else {
          // A card can only occupy one cell — placing it elsewhere moves it. Net size only grows when
          // both the card is brand-new to this team AND the target cell isn't already overwriting another card.
          const prevCell = this.cellForCard(cardInstanceId);
          const willGrow = !prevCell && !this.garrison.has(key);
          if (willGrow && this.garrison.size >= CARD_TEAM_MAX_SIZE) {
            this.showToast(t('world.team.full'), C.red);
            return;
          }
          if (prevCell && prevCell !== key) this.garrison.delete(prevCell);
          const troops = this.cardState[cardInstanceId]?.currentTroops ?? 0;
          this.garrison.set(key, { unitType, hp: troops, cardInstanceId });
          // Select the just-placed card so its allocate stepper appears immediately.
          this.selectedCell = key;
        }
      } else if (this.tool.kind === 'unit') {
        if (!this.garrison.has(key) && this.garrison.size >= MAX_GARRISON) {
          this.showToast(t('world.defense.full'), C.red);
          return;
        }
        const maxHp = UNIT_BLUEPRINTS[this.tool.type].hp;
        this.garrison.set(key, { unitType: this.tool.type, hp: maxHp });
      } else {
        this.showToast(t('world.defense.buildingsNotHere'), C.red);
        return;
      }
    }
    this.render();
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  private showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  private handleDown(x: number, y: number): void {
    let hit: (() => void) | null = null;
    for (const { rect, action } of this.hits) {
      if (x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h) { hit = action; break; }
    }
    // The card roster (attack mode, right half) scrolls — defer its hit to pointer-up so a drag that
    // starts on a card scrolls instead of selecting it (see scroll-drag-throttle-pattern memory).
    const inRoster = this.mode === 'attack' && x >= this.rosterX && x <= this.rosterX + this.rosterW
      && y >= this.rosterY && y <= this.rosterY + this.rosterH;
    if (inRoster) { this.gesture.down(this.scrollY, y, hit); return; }
    if (hit) { hit(); return; }
    this.onGridTap(x, y);
  }

  private handleMove(y: number): void {
    const scroll = this.gesture.move(y);
    if (scroll !== null) { this.scrollY = Math.min(this.scrollMax, scroll); this.scrollDirty = true; }
  }

  private handleUp(): void {
    this.gesture.up()?.();
  }

  update(_dt: number): void {
    // Drain the drag-scroll flag once per frame instead of rendering inline from handleMove
    // (see scroll-drag-throttle-pattern memory).
    if (this.scrollDirty) { this.scrollDirty = false; this.render(); }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    // Free descendant Text baseTextures before dropping the container (overlay over the live
    // WorldMapScene → leaks a screenful of Text per close otherwise). See sketchUi.tearDownChildren.
    tearDownChildren(this.container);
    this.container.destroy({ children: true });
  }
}
