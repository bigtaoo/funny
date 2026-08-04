// Shared foundation for the DefenseEditorScene mixin chain (see ../DefenseEditorScene.ts assembly).
//
// DefenseEditorSceneBase holds every instance field (all `protected`, so the domain mixin bodies keep
// referencing them verbatim: this.mode, this.garrison, this.bodyLayer, …) + the layer scaffold, the
// render dispatcher, and the shared title/tool/roster/toast primitives. Each domain (data / render /
// input) lives in its own sibling file as `XMixin(Base)` and is chained into the final
// DefenseEditorScene.
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t, type TranslationKey } from '../../i18n';
import { ui as C, txt, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { FS } from '../../render/fontScale';
import { drawSceneHeader, HEADER_ACCENT } from '../../ui/widgets/SceneHeader';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import type { WorldApiClient, TeamTemplate, CardSLGState } from '../../net/WorldApiClient';
import { BASE_UPGRADE_COSTS, CARD_DEFINITIONS } from '@nw/engine/config';
import { CardType, UnitType, BuildingType } from '@nw/engine/types';
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, troopCap, cardPower } from '../../game/meta/cardDefs';
import { teamTroopCap, teamLeaderCard } from '../../game/meta/teamTroops';

/** Max defender base upgrade level the engine schema accepts (0..BASE_UPGRADE_COSTS.length). */
export const MAX_BASE_LEVEL = BASE_UPGRADE_COSTS.length;

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
  /** Subscribe to SaveManager writes; re-renders this scene when a concurrently-mounted peer scene (e.g. the world map's other overlays) changes the wallet/cardInv while this editor is open. Push the returned unsub onto `unsubs`. */
  onSaveChanged?(listener: () => void): () => void;
}

// ── Collected pool (U8) ───────────────────────────────────────────────────────
// Only unit/building types from card definitions = the player's "collected" placeable set; preserves card table order.

export function distinctCollected<T extends string>(pick: (c: typeof CARD_DEFINITIONS[number]) => T | undefined): T[] {
  const out: T[] = [];
  for (const card of CARD_DEFINITIONS) {
    const v = pick(card);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export const COLLECTED_UNITS = distinctCollected((c) =>
  c.cardType === CardType.Unit ? (c.unitType as UnitType | undefined) : undefined);
export const COLLECTED_BUILDINGS = distinctCollected((c) =>
  c.cardType === CardType.Building ? (c.buildingType as BuildingType | undefined) : undefined);

/** First card display-name key for a given unit/building type (label reuse, no new keys). */
export function nameKeyFor(kind: 'unit' | 'building', type: string): TranslationKey {
  for (const card of CARD_DEFINITIONS) {
    if (kind === 'unit' && card.unitType === type) return card.nameKey as TranslationKey;
    if (kind === 'building' && card.buildingType === type) return card.nameKey as TranslationKey;
  }
  return 'world.defense.title';
}

/** ms remaining → compact countdown string ("12m" / "45s"); mirrors CardScene's injuryCountdown. */
export function msCountdown(untilMs: number, nowMs: number): string {
  const secsLeft = Math.max(0, Math.ceil((untilMs - nowMs) / 1000));
  return secsLeft >= 60 ? `${Math.ceil(secsLeft / 60)}m` : `${secsLeft}s`;
}

// ── Tools ──────────────────────────────────────────────────────────────────────

export type Tool =
  | { kind: 'unit'; type: UnitType }
  | { kind: 'building'; type: BuildingType }
  | { kind: 'card'; cardInstanceId: string; unitType: UnitType }
  // Attack mode: tap a placed card to make it the team's leader (its portrait becomes the team icon).
  | { kind: 'leader' }
  | { kind: 'erase' };

// Defender deployment zone shown top→bottom: building row first, then garrison rows
// 16..9 (defender's own half). Garrison schema allows rows 1..16; we expose the back
// half which is where a defender realistically forts up — keeps the grid mobile-sized.
export const DEFENSE_ROWS = [16, 15, 14, 13, 12, 11, 10, 9] as const;
// Attacker (Bottom) half shown top→bottom: rows 8..1 (1 = home spawn row at the bottom).
export const ATTACK_ROWS = [8, 7, 6, 5, 4, 3, 2, 1] as const;

export const MAX_GARRISON = 30;

/**
 * hp: defense-mode blueprint HP allocation; attack-mode current cardState troop count (display cache,
 * refreshed from this.cardState on each render via committedTroops()/drawUnit — see cardInstanceId).
 */
export type GarrisonEntry = { unitType: UnitType; hp: number; cardInstanceId?: string };

// ── Caps / layout ────────────────────────────────────────────────────────────

export const PALETTE_H = 54;
export const FOOTER_H = 58;
export const PAD = 10;

// ── Mixin plumbing ────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = object> = new (...args: any[]) => T;
export type DefenseEditorSceneBaseCtor = Constructor<DefenseEditorSceneBase>;

// ── Scene ───────────────────────────────────────────────────────────────────────

export class DefenseEditorSceneBase {
  readonly container: PIXI.Container;

  protected readonly w: number;
  protected readonly h: number;
  protected readonly cb: DefenseEditorCallbacks;

  // Mode-derived layout (G3-2c)
  protected readonly mode: 'defense' | 'attack';
  protected readonly gRows: readonly number[];      // garrison/army rows shown (top→bottom)
  protected readonly hasBuildingRow: boolean;        // defense only: building row + base level

  // Config state
  protected buildings = new Map<number, BuildingType>();        // col → building (building row)
  protected garrison = new Map<string, GarrisonEntry>();        // "col:row" → { unitType, hp }
  protected baseLevel = 0;
  // Attack mode: the full team list (loaded once) so save merges this slot without clobbering others.
  protected teams: TeamTemplate[] = [];
  // Attack mode: 占领后自动回城 (2026-07-23). false (default) = the team stays stationed on a tile it moves to /
  // captures; true = it marches home afterward. Persisted on the TeamTemplate via setTeams.
  protected autoReturn = false;
  // Attack mode: the card whose portrait stands for this team in the city / world-map team lists
  // (2026-07-25). null = never chosen, and the lists fall back to the strongest card — see
  // teamLeaderCard(). Purely cosmetic today; persisted on the TeamTemplate via setTeams.
  protected leaderCardId: string | null = null;
  // Attack mode: this account's live card ledger (troops/injury/teamId), fetched alongside teams.
  protected cardState: Record<string, CardSLGState> = {};
  // Attack mode: the unified base troop pool (playerWorld.troops) available to distribute to this team's
  // cards (CHARACTER_CARDS_DESIGN §6.3/§6.5). Trained on the home desk's Train Troops tile.
  protected troops = 0;
  protected tool: Tool = { kind: 'erase' };
  protected loading = true;
  protected saving = false;
  protected filling = false;
  protected destroyed = false;

  // Attack mode: right-half card roster is a scrollable vertical grid (left half = formation grid).
  // Same tap-vs-drag disambiguation as TeamsScene's roster grid — see ScrollTapGesture.
  protected scrollY = 0;
  protected scrollMax = 0;
  protected scrollDirty = false;
  protected readonly gesture = new ScrollTapGesture();
  protected rosterX = 0;
  protected rosterY = 0;
  protected rosterW = 0;
  protected rosterH = 0;
  protected readonly artHooked = new Set<string>();

  // Attack mode drag-to-place: press a roster card and drag it onto a grid cell to deploy it, as an
  // alternative to tap-select-then-tap-place. A candidate is armed on pointer-down over a roster card;
  // it promotes to an active drag once the pointer leaves the roster (crosses into the grid half), which
  // also cancels the scroll gesture so a horizontal drag-out never scrolls the list. The drop reuses
  // onGridTap (selecting the card as the active tool first), so all placement rules stay in one place.
  protected rosterCardHits: { rect: { x: number; y: number; w: number; h: number }; cardId: string; unitType: UnitType }[] = [];
  protected dragCardId: string | null = null;
  protected dragUnitType: UnitType | null = null;
  protected dragging = false;
  protected dragLayer!: PIXI.Container;      // persistent ghost layer (survives bodyLayer teardown)
  protected dragGhost: PIXI.Container | null = null;

  // Layers
  protected bodyLayer!: PIXI.Container;

  // Hit rects (rebuilt each render)
  protected hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];

  // Grid geometry (computed in render)
  protected gridX = 0;
  protected gridY = 0;
  protected cellW = 0;
  protected cellH = 0;

  protected readonly unsubs: (() => void)[] = [];

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
    // Drag ghost lives above the body layer and is NOT torn down by render(), so it can follow the
    // pointer without a full re-render per move (attack-mode drag-to-place).
    this.dragLayer = new PIXI.Container();
    this.container.addChild(this.dragLayer);

    this.unsubs.push(input.onDown((x, y) => this.handleDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => this.handleMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => this.handleUp(x, y)));
    // Card roster (attack mode, right half) mouse-wheel scroll — same region gate as handleDown's
    // inRoster check, browser/PC only (see wheelScroll.ts).
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      if (this.mode !== 'attack') return;
      if (x < this.rosterX || x > this.rosterX + this.rosterW) return;
      const next = wheelScrollY(this.rosterY, this.rosterY + this.rosterH, y, deltaY, this.scrollY, this.scrollMax);
      if (next !== null) { this.scrollY = next; this.scrollDirty = true; }
    }));
    if (cb.onSaveChanged) this.unsubs.push(cb.onSaveChanged(() => { if (!this.destroyed) this.render(); }));

    this.render();
    void this.loadData();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  /** Scene title: team name (attack) / home base or tile (defense). */
  protected titleText(): string {
    return this.cb.target.mode === 'attack'
      ? t('world.team.editTitle').replace('{name}', this.cb.target.teamName)
      : this.cb.target.tileKey === 'base'
        ? t('world.defense.titleBase')
        : t('world.defense.titleTile').replace('{tile}', this.cb.target.tileKey);
  }

  protected render(): void {
    tearDownChildren(this.bodyLayer);
    this.hits = [];
    this.rosterCardHits = [];
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

    if (this.loading) {
      const lbl = txt(t('world.loading'), FS.tiny, C.mid);
      lbl.anchor.set(0.5, 0.5);
      lbl.x = w / 2; lbl.y = h / 2;
      this.bodyLayer.addChild(lbl);
    }
  }

  protected toolEquals(a: Tool, b: Tool): boolean {
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
  protected availableCards(): { card: CardInstance; unitType: UnitType; troops: number; cap: number }[] {
    const cardInv = this.cb.getSave?.().cardInv ?? {};
    const equipmentInv = this.cb.getSave?.().equipmentInv ?? {};
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
    // Roster is sorted by combat power (highest first) so strong cards are easy to find (design ask 2026-08-01).
    out.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));
    return out;
  }

  /** Which cell (if any) a given card is currently placed at, in this in-progress edit. */
  protected cellForCard(cardInstanceId: string): string | undefined {
    for (const [key, entry] of this.garrison) if (entry.cardInstanceId === cardInstanceId) return key;
    return undefined;
  }

  /** Per-card troop cap (statistics-derived) for a placed card instance; 0 if the card is no longer owned. */
  protected capForCard(cardInstanceId: string): number {
    const card = this.cb.getSave?.().cardInv?.[cardInstanceId];
    return card ? troopCap(card) : 0;
  }

  /** Attacker army committed troops = sum of each placed card's live cardState.currentTroops (consistent with TeamsScene / server). */
  protected committedTroops(): number {
    let sum = 0;
    for (const entry of this.garrison.values()) {
      sum += entry.cardInstanceId ? (this.cardState[entry.cardInstanceId]?.currentTroops ?? 0) : entry.hp;
    }
    return sum;
  }

  /** Sum of troopCap() over placed cards — the formation's max troop capacity, for the "committed/cap" readout and the Fill-troops disabled state. */
  protected teamCapacity(): number {
    return teamTroopCap(this.buildArmy(), this.cb.getSave?.().cardInv);
  }

  /**
   * The card currently standing for this team — the explicit 领队 pick, or the strongest placed card
   * while none has been made. Drawn with a ★ on the grid so the player can see which portrait the city /
   * world-map lists will use, including the automatic one they never chose.
   */
  protected effectiveLeaderId(): string | undefined {
    if (this.mode !== 'attack') return undefined;
    const save = this.cb.getSave?.();
    return teamLeaderCard(
      { army: this.buildArmy(), leaderCardId: this.leaderCardId ?? undefined },
      save?.cardInv,
      save?.equipmentInv,
    )?.id;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  protected showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Scene interface ───────────────────────────────────────────────────────

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

// ── Domain entrypoints dispatched to from base-level code (render dispatcher, constructor) and across
// sibling mixins (render → input; input → data; render → data). Declared via interface/class
// declaration merging so base-level `this.renderPalette()` / `this.loadData()` type-check as METHODS
// (not properties, which would clash with the mixin override — TS2425). Emits NOTHING at runtime, so
// the real prototype methods provided by the mixins run and all method bodies stay verbatim.
export interface DefenseEditorSceneBase {
  // data
  loadData(): Promise<void>;
  applyArmy(army: import('../../net/WorldApiClient').ArmyEntry[]): void;
  applyConfig(cfg: Record<string, unknown>): void;
  buildArmy(): import('../../net/WorldApiClient').ArmyEntry[];
  persistTeam(): Promise<void>;
  doSave(): Promise<void>;
  doFillTroops(): Promise<void>;
  errorMsg(e: unknown): string;
  injuredCardMsg(raw: string): string;
  // render
  renderBaseStepper(rightX: number, y: number): void;
  renderPalette(top: number): void;
  renderAttackBody(top: number, bottom: number): void;
  renderAttackToolbar(x: number, y: number, w: number, h: number): void;
  renderCardRosterPanel(x: number, y: number, w: number, h: number): void;
  renderRosterCell(
    c: { card: CardInstance; unitType: UnitType; troops: number; cap: number },
    x: number, y: number, cellW: number, cellH: number,
  ): void;
  drawArtFit(url: string, x: number, y: number, boxW: number, boxH: number): void;
  renderGrid(top: number, bottom: number, areaX?: number, areaW?: number): void;
  drawBuilding(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: BuildingType): void;
  drawUnit(g: PIXI.Graphics, px: number, py: number, cw: number, ch: number, type: UnitType, hp?: number, cap?: number, isLeader?: boolean): void;
  renderFooter(top: number): void;
  renderAttackHeaderControls(headerH: number): void;
  renderActionButtons(rightEdge: number, top: number, rowH: number, scale?: number): void;
  // input
  onGridTap(sx: number, sy: number): void;
  handleDown(x: number, y: number): void;
  handleMove(x: number, y: number): void;
  handleUp(x: number, y: number): void;
  startDragGhost(x: number, y: number): void;
  moveDragGhost(x: number, y: number): void;
  clearDragGhost(): void;
  clearDrag(): void;
}
