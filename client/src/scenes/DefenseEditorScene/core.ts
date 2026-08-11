// Shared foundation for the DefenseEditorScene composition (see ../DefenseEditorScene.ts assembly).
//
// DefenseEditorSceneCore holds every instance field (all `public`, so the domain classes below keep
// referencing them via `this.core.xxx`: this.core.mode, this.core.garrison, this.core.bodyLayer, …)
// + the layer scaffold and the shared title/tool/roster/toast primitives — but NOT the render()
// dispatcher, which lives on the outer ../DefenseEditorScene.ts assembly since only it knows about
// every domain class (Core takes a `render` callback injected at construction instead of owning
// render() itself). Core DOES wire all four InputManager subscriptions itself (onDown/onMove/onUp/
// onWheel), pushing into its own `unsubs` — same file as the destroy() drain that empties it, per
// the input-subscription-cleanup convention (test/input-subscription-cleanup.test.ts statically
// scans for push+drain living in the same file). onDown/onMove/onUp delegate to the InputPanel
// domain instance, which doesn't exist yet when Core is constructed — so the outer assembly passes
// three lazy closures (`handlers.onDown` etc., each `(x,y) => this.input.handleDown(x,y)`) instead
// of the InputPanel instance itself; by the time InputManager actually fires one, the outer
// assembly's constructor has already finished and `this.input` exists (same lazy-binding trick as
// the `render` callback). onWheel's body only touches Core's own fields, so it's implemented here
// directly with no handler indirection. Each domain (data / render / input) is its own independent
// class in a sibling file, constructed with `core` (2026-08-11: converted from the former
// `XMixin(Base)` inheritance chain — the render-dispatch upward calls this used to reach via
// interface declaration merging are now explicit constructor params/callbacks instead, see
// claudedocs/client-modules.md's split-form priority note).
import * as PIXI from 'pixi.js-legacy';
import type { ILayout } from '../../layout/ILayout';
import type { InputManager } from '../../inputSystem/InputManager';
import { t } from '../../i18n';
import { ui as C, buildPaperBackground, tearDownChildren } from '../../render/sketchUi';
import { showToastMessage } from '../../net/log';
import { buildDecorCLayer } from '../../render/decorCLayer';
import { ScrollTapGesture } from '../../ui/scrollTapGesture';
import { wheelScrollY } from '../../ui/wheelScroll';
import type {
  WorldApiClient,
  TeamTemplate,
  CardSLGState,
  ArmyEntry,
} from '../../net/WorldApiClient';
import { BASE_UPGRADE_COSTS, CARD_DEFINITIONS } from '@nw/engine/config';
import { CardType, UnitType, BuildingType } from '@nw/engine/types';
import type { SaveData, CardInstance } from '../../game/meta/SaveData';
import { CARD_DEFS, troopCap, cardPower } from '../../game/meta/cardDefs';
import { teamTroopCap, teamLeaderCard } from '../../game/meta/teamTroops';
import type { TranslationKey } from '../../i18n';

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

export function distinctCollected<T extends string>(
  pick: (c: (typeof CARD_DEFINITIONS)[number]) => T | undefined
): T[] {
  const out: T[] = [];
  for (const card of CARD_DEFINITIONS) {
    const v = pick(card);
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export const COLLECTED_UNITS = distinctCollected((c) =>
  c.cardType === CardType.Unit ? (c.unitType as UnitType | undefined) : undefined
);
export const COLLECTED_BUILDINGS = distinctCollected((c) =>
  c.cardType === CardType.Building ? (c.buildingType as BuildingType | undefined) : undefined
);

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

// ── Scene ───────────────────────────────────────────────────────────────────────

export class DefenseEditorSceneCore {
  readonly container: PIXI.Container;

  readonly w: number;
  readonly h: number;
  readonly cb: DefenseEditorCallbacks;

  // Mode-derived layout (G3-2c)
  readonly mode: 'defense' | 'attack';
  readonly gRows: readonly number[]; // garrison/army rows shown (top→bottom)
  readonly hasBuildingRow: boolean; // defense only: building row + base level

  // Config state
  buildings = new Map<number, BuildingType>(); // col → building (building row)
  garrison = new Map<string, GarrisonEntry>(); // "col:row" → { unitType, hp }
  baseLevel = 0;
  // Attack mode: the full team list (loaded once) so save merges this slot without clobbering others.
  teams: TeamTemplate[] = [];
  // Attack mode: 占领后自动回城 (2026-07-23). false (default) = the team stays stationed on a tile it moves to /
  // captures; true = it marches home afterward. Persisted on the TeamTemplate via setTeams.
  autoReturn = false;
  // Attack mode: the card whose portrait stands for this team in the city / world-map team lists
  // (2026-07-25). null = never chosen, and the lists fall back to the strongest card — see
  // teamLeaderCard(). Purely cosmetic today; persisted on the TeamTemplate via setTeams.
  leaderCardId: string | null = null;
  // Attack mode: this account's live card ledger (troops/injury/teamId), fetched alongside teams.
  cardState: Record<string, CardSLGState> = {};
  // Attack mode: the unified base troop pool (playerWorld.troops) available to distribute to this team's
  // cards (CHARACTER_CARDS_DESIGN §6.3/§6.5). Trained on the home desk's Train Troops tile.
  troops = 0;
  tool: Tool = { kind: 'erase' };
  loading = true;
  saving = false;
  filling = false;
  destroyed = false;

  // Attack mode: right-half card roster is a scrollable vertical grid (left half = formation grid).
  // Same tap-vs-drag disambiguation as TeamsScene's roster grid — see ScrollTapGesture.
  scrollY = 0;
  scrollMax = 0;
  scrollDirty = false;
  readonly gesture = new ScrollTapGesture();
  rosterX = 0;
  rosterY = 0;
  rosterW = 0;
  rosterH = 0;
  readonly artHooked = new Set<string>();

  // Attack mode drag-to-place: press a roster card and drag it onto a grid cell to deploy it, as an
  // alternative to tap-select-then-tap-place. A candidate is armed on pointer-down over a roster card;
  // it promotes to an active drag once the pointer leaves the roster (crosses into the grid half), which
  // also cancels the scroll gesture so a horizontal drag-out never scrolls the list. The drop reuses
  // onGridTap (selecting the card as the active tool first), so all placement rules stay in one place.
  rosterCardHits: {
    rect: { x: number; y: number; w: number; h: number };
    cardId: string;
    unitType: UnitType;
  }[] = [];
  dragCardId: string | null = null;
  dragUnitType: UnitType | null = null;
  dragging = false;
  dragLayer!: PIXI.Container; // persistent ghost layer (survives bodyLayer teardown)
  dragGhost: PIXI.Container | null = null;

  // Layers
  bodyLayer!: PIXI.Container;

  // Hit rects (rebuilt each render)
  hits: { rect: { x: number; y: number; w: number; h: number }; action: () => void }[] = [];

  // Grid geometry (computed in render)
  gridX = 0;
  gridY = 0;
  cellW = 0;
  cellH = 0;

  /** Drained by destroy() below — see the file-header comment for why the push calls (onDown/
   *  onMove/onUp/onWheel + onSaveChanged) all live in this same file. */
  readonly unsubs: (() => void)[] = [];

  /**
   * @param render Injected by the outer DefenseEditorScene assembly (which owns the actual render
   *   dispatcher, since it's the only thing that knows about all domain classes) — Core and the
   *   domain classes call `this.render()`/`this.core.render()` wherever the old flattened class
   *   called its own `render()` method verbatim. Does NOT auto-fire the initial render/loadData —
   *   the outer assembly does that after all domain instances exist.
   * @param handlers Lazy closures over the outer assembly's InputPanel instance (onDown/onMove/onUp
   *   route to real domain logic that doesn't exist yet at construction time) — see the file-header
   *   comment.
   */
  constructor(
    layout: ILayout,
    cb: DefenseEditorCallbacks,
    readonly render: () => void,
    input: InputManager,
    handlers: {
      onDown: (x: number, y: number) => void;
      onMove: (x: number, y: number) => void;
      onUp: (x: number, y: number) => void;
    }
  ) {
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

    if (cb.onSaveChanged)
      this.unsubs.push(
        cb.onSaveChanged(() => {
          if (!this.destroyed) this.render();
        })
      );

    this.unsubs.push(input.onDown((x, y) => handlers.onDown(x, y)));
    this.unsubs.push(input.onMove((x, y) => handlers.onMove(x, y)));
    this.unsubs.push(input.onUp((x, y) => handlers.onUp(x, y)));
    // Card roster (attack mode, right half) mouse-wheel scroll — same region gate as handleDown's
    // inRoster check, browser/PC only (see wheelScroll.ts). Body only touches this's own fields (no
    // InputPanel method needed), so it's implemented inline instead of via a `handlers` callback.
    // prettier-ignore
    this.unsubs.push(input.onWheel((x, y, deltaY) => {
      if (this.mode !== 'attack') return;
      if (x < this.rosterX || x > this.rosterX + this.rosterW) return;
      const next = wheelScrollY(
        this.rosterY,
        this.rosterY + this.rosterH,
        y,
        deltaY,
        this.scrollY,
        this.scrollMax
      );
      if (next !== null) {
        this.scrollY = next;
        this.scrollDirty = true;
      }
    }));
  }

  // ── Render helpers ────────────────────────────────────────────────────────────

  /** Scene title: team name (attack) / home base or tile (defense). */
  titleText(): string {
    return this.cb.target.mode === 'attack'
      ? t('world.team.editTitle').replace('{name}', this.cb.target.teamName)
      : this.cb.target.tileKey === 'base'
      ? t('world.defense.titleBase')
      : t('world.defense.titleTile').replace('{tile}', this.cb.target.tileKey);
  }

  toolEquals(a: Tool, b: Tool): boolean {
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
  availableCards(): { card: CardInstance; unitType: UnitType; troops: number; cap: number }[] {
    const cardInv = this.cb.getSave?.().cardInv ?? {};
    const equipmentInv = this.cb.getSave?.().equipmentInv ?? {};
    const myTeamId =
      this.mode === 'attack' ? (this.cb.target as { teamId: string }).teamId : undefined;
    const now = Date.now();
    const out: { card: CardInstance; unitType: UnitType; troops: number; cap: number }[] = [];
    for (const card of Object.values(cardInv)) {
      const def = CARD_DEFS[card.defId];
      if (!def) continue;
      const st = this.cardState[card.id];
      if ((st?.injuredUntil ?? 0) > now) continue;
      if (st?.teamId && st.teamId !== myTeamId) continue;
      out.push({
        card,
        unitType: def.unitType as UnitType,
        troops: st?.currentTroops ?? 0,
        cap: troopCap(card),
      });
    }
    // Roster is sorted by combat power (highest first) so strong cards are easy to find (design ask 2026-08-01).
    out.sort((a, b) => cardPower(b.card, equipmentInv) - cardPower(a.card, equipmentInv));
    return out;
  }

  /** Which cell (if any) a given card is currently placed at, in this in-progress edit. */
  cellForCard(cardInstanceId: string): string | undefined {
    for (const [key, entry] of this.garrison)
      if (entry.cardInstanceId === cardInstanceId) return key;
    return undefined;
  }

  /** Per-card troop cap (statistics-derived) for a placed card instance; 0 if the card is no longer owned. */
  capForCard(cardInstanceId: string): number {
    const card = this.cb.getSave?.().cardInv?.[cardInstanceId];
    return card ? troopCap(card) : 0;
  }

  /** Attacker army committed troops = sum of each placed card's live cardState.currentTroops (consistent with TeamsScene / server). */
  committedTroops(): number {
    let sum = 0;
    for (const entry of this.garrison.values()) {
      sum += entry.cardInstanceId
        ? this.cardState[entry.cardInstanceId]?.currentTroops ?? 0
        : entry.hp;
    }
    return sum;
  }

  /** Sum of troopCap() over placed cards — the formation's max troop capacity, for the "committed/cap" readout and the Fill-troops disabled state. */
  teamCapacity(): number {
    return teamTroopCap(this.buildArmy(), this.cb.getSave?.().cardInv);
  }

  /**
   * Attacker army: each placed cell is a hero card at that position — troops live in cardState, not
   * here. Lives on Core (not DataPanel, data.ts) even though it's conceptually "data shaping"
   * because teamCapacity()/effectiveLeaderId() below (both Core methods, called from render.ts in
   * attack mode) need it too — DataPanel's persistTeam()/doSave() call `this.core.buildArmy()`. A
   * true two-way dependency here (Core needing DataPanel AND DataPanel needing Core) would be the
   * "boundary drawn wrong" case per claudedocs/client-modules.md's composition rule; since this
   * method only ever reads `this.garrison`, moving it down to the shared root is the fix, not a
   * narrowed interface in either direction.
   */
  buildArmy(): ArmyEntry[] {
    return [...this.garrison.entries()].map(([key, entry]) => {
      const [col, row] = key.split(':').map(Number);
      return { cardInstanceId: entry.cardInstanceId!, col: col!, row: row! };
    });
  }

  /**
   * The card currently standing for this team — the explicit 领队 pick, or the strongest placed card
   * while none has been made. Drawn with a ★ on the grid so the player can see which portrait the city /
   * world-map lists will use, including the automatic one they never chose.
   */
  effectiveLeaderId(): string | undefined {
    if (this.mode !== 'attack') return undefined;
    const save = this.cb.getSave?.();
    return teamLeaderCard(
      { army: this.buildArmy(), leaderCardId: this.leaderCardId ?? undefined },
      save?.cardInv,
      save?.equipmentInv
    )?.id;
  }

  // ── Toast ──────────────────────────────────────────────────────────────────

  showToast(msg: string, color: number = C.dark): void {
    showToastMessage(msg, color === C.red ? 'error' : 'success');
  }

  // ── Scene interface ───────────────────────────────────────────────────────

  update(_dt: number): void {
    // Drain the drag-scroll flag once per frame instead of rendering inline from handleMove
    // (see scroll-drag-throttle-pattern memory).
    if (this.scrollDirty) {
      this.scrollDirty = false;
      this.render();
    }
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
