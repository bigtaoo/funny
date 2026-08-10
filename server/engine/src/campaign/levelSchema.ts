import type { LevelDefinition } from './LevelDefinition';
import { MAX_BASE_LEVEL, fail, int, isObject, num, optStringArray, str } from './levelSchema/helpers';
import { parseObjective } from './levelSchema/objective';
import { parseWaves } from './levelSchema/waves';
import { parseBoard } from './levelSchema/board';
import { parseHazards } from './levelSchema/hazards';
import { parseEscorts } from './levelSchema/escorts';
import { parseAttackerArmy, parseDefenderBuildings, parseGarrison } from './levelSchema/garrison';
import { parseRewards } from './levelSchema/rewards';

export { LevelParseError } from './levelSchema/helpers';

/**
 * Runtime validator for campaign levels loaded from JSON.
 *
 * Campaign levels live as JSON (single source of truth, authored by the level
 * editor — see `tools/level-editor/DESIGN.md`) and are bundled at build time.
 * JSON gives no compile-time type safety, so {@link parseLevelDefinition} is the
 * sole guard: it narrows raw `unknown` to a {@link LevelDefinition}, rejecting
 * malformed data with a field-path error that pinpoints the offending key.
 *
 * Validation is intentionally strict about anything the engine consumes
 * (objective kind, unit types, lanes, cell bounds) and lenient/pass-through for
 * reserved-but-unconsumed fields (hazards, crossWaypoints, story keys), which
 * are preserved verbatim so editing a level never silently drops future data.
 *
 * ── Split (2026-08-10, independent function module range 6) ──
 * The file was already a set of mutually-independent `parse*` functions sharing
 * only the primitive validators (`isObject`/`fail`/`num`/`int`/`str`/…) and a
 * few lookup sets (`ATTACK_LANE_SET`/`UNIT_TYPE_SET`/`BUILDING_TYPE_SET`) — no
 * class, no shared mutable state — so this is a straight independent-function-
 * module split by schema domain: `levelSchema/{helpers,objective,waves,board,
 * hazards,escorts,garrison,rewards}.ts`. This file keeps only the top-level
 * `parseLevelDefinition` orchestrator, which stitches the per-field parsers
 * together in the same order as the original function body.
 */
export function parseLevelDefinition(raw: unknown, ctx = 'level'): LevelDefinition {
  if (!isObject(raw)) fail(ctx, 'expected a level object');

  // A siege battle (pre-placed attacker army / hard time limit, §16) carries no scripted
  // waves; everywhere else ≥1 wave entry is still required.
  const isSiegeBattle = raw.attackerArmy !== undefined || raw.battleTimeoutTicks !== undefined;

  const level: LevelDefinition = {
    id: str(raw.id, `${ctx}.id`),
    chapter: int(raw.chapter, `${ctx}.chapter`),
    seed: num(raw.seed, `${ctx}.seed`),
    objective: parseObjective(raw.objective, `${ctx}.objective`),
    waves: parseWaves(raw.waves, `${ctx}.waves`, isSiegeBattle),
  };
  if (level.id.length === 0) fail(`${ctx}.id`, 'must be a non-empty id');

  const board = parseBoard(raw.board, `${ctx}.board`);
  if (board) level.board = board;

  const hazards = parseHazards(raw.hazards, `${ctx}.hazards`);
  if (hazards) level.hazards = hazards;

  if (raw.startInk !== undefined) {
    const startInk = int(raw.startInk, `${ctx}.startInk`);
    if (startInk < 0) fail(`${ctx}.startInk`, `must be >= 0, got ${startInk}`);
    level.startInk = startInk;
  }
  if (raw.inkRegenMult !== undefined) {
    const m = num(raw.inkRegenMult, `${ctx}.inkRegenMult`);
    if (m < 0) fail(`${ctx}.inkRegenMult`, `must be >= 0, got ${m}`);
    level.inkRegenMult = m;
  }

  const loadout = optStringArray(raw.loadout, `${ctx}.loadout`);
  if (loadout) level.loadout = loadout;
  const bannedCards = optStringArray(raw.bannedCards, `${ctx}.bannedCards`);
  if (bannedCards) level.bannedCards = bannedCards;

  if (raw.levelSpells !== undefined) {
    if (!Array.isArray(raw.levelSpells)) fail(`${ctx}.levelSpells`, 'expected an array');
    level.levelSpells = (raw.levelSpells as unknown[]).map((s, i) => {
      const sp = `${ctx}.levelSpells[${i}]`;
      if (!isObject(s)) fail(sp, 'expected a {cardId, initialCount} object');
      const cardId      = str(s.cardId,      `${sp}.cardId`);
      const initialCount = int(s.initialCount, `${sp}.initialCount`);
      if (initialCount < 0) fail(`${sp}.initialCount`, 'must be >= 0');
      return { cardId, initialCount };
    });
  }

  if (raw.enemyScale !== undefined) {
    if (!isObject(raw.enemyScale)) fail(`${ctx}.enemyScale`, 'expected an {hp?, damage?} object');
    const es: NonNullable<LevelDefinition['enemyScale']> = {};
    if (raw.enemyScale.hp !== undefined) {
      const hp = num(raw.enemyScale.hp, `${ctx}.enemyScale.hp`);
      if (hp <= 0) fail(`${ctx}.enemyScale.hp`, `must be > 0, got ${hp}`);
      es.hp = hp;
    }
    if (raw.enemyScale.damage !== undefined) {
      const dmg = num(raw.enemyScale.damage, `${ctx}.enemyScale.damage`);
      if (dmg <= 0) fail(`${ctx}.enemyScale.damage`, `must be > 0, got ${dmg}`);
      es.damage = dmg;
    }
    if (es.hp !== undefined || es.damage !== undefined) level.enemyScale = es;
  }

  const escorts = parseEscorts(raw.escorts, `${ctx}.escorts`);
  if (escorts && escorts.length > 0) level.escorts = escorts;

  const garrison = parseGarrison(raw.garrison, `${ctx}.garrison`);
  if (garrison && garrison.length > 0) level.garrison = garrison;

  const attackerArmy = parseAttackerArmy(raw.attackerArmy, `${ctx}.attackerArmy`);
  if (attackerArmy && attackerArmy.length > 0) level.attackerArmy = attackerArmy;

  if (raw.battleTimeoutTicks !== undefined) {
    const t = int(raw.battleTimeoutTicks, `${ctx}.battleTimeoutTicks`);
    if (t <= 0) fail(`${ctx}.battleTimeoutTicks`, `must be > 0, got ${t}`);
    level.battleTimeoutTicks = t;
  }

  const defenderBuildings = parseDefenderBuildings(raw.defenderBuildings, `${ctx}.defenderBuildings`);
  if (defenderBuildings && defenderBuildings.length > 0) level.defenderBuildings = defenderBuildings;

  if (raw.defenderBaseLevel !== undefined) {
    const lvl = int(raw.defenderBaseLevel, `${ctx}.defenderBaseLevel`);
    if (lvl < 0 || lvl > MAX_BASE_LEVEL) {
      fail(`${ctx}.defenderBaseLevel`, `must be 0..${MAX_BASE_LEVEL}, got ${lvl}`);
    }
    level.defenderBaseLevel = lvl;
  }

  if (raw.defenderBaseHp !== undefined) {
    const hp = int(raw.defenderBaseHp, `${ctx}.defenderBaseHp`);
    // Absolute HP ceiling for the defender base (SLG NPC-tile scaling). Upper bound is generous — a sanity cap
    // against dirty data, not a balance knob (npcBaseHp tops out at 40×10=400 today).
    if (hp < 1 || hp > 100_000) {
      fail(`${ctx}.defenderBaseHp`, `must be 1..100000, got ${hp}`);
    }
    level.defenderBaseHp = hp;
  }

  const rewards = parseRewards(raw.rewards, `${ctx}.rewards`);
  if (rewards) level.rewards = rewards;

  if (raw.staminaCost !== undefined) {
    const sc = int(raw.staminaCost, `${ctx}.staminaCost`);
    if (sc < 1 || sc > 5) fail(`${ctx}.staminaCost`, `must be 1..5, got ${sc}`);
    level.staminaCost = sc;
  }

  if (raw.nameKey !== undefined) {
    level.nameKey = str(raw.nameKey, `${ctx}.nameKey`) as LevelDefinition['nameKey'];
  }

  if (raw.briefKey !== undefined) {
    level.briefKey = str(raw.briefKey, `${ctx}.briefKey`) as LevelDefinition['briefKey'];
  }

  if (raw.story !== undefined) {
    if (!isObject(raw.story)) fail(`${ctx}.story`, 'expected a story object');
    const story: NonNullable<LevelDefinition['story']> = {};
    if (raw.story.introKey !== undefined) {
      story.introKey = str(raw.story.introKey, `${ctx}.story.introKey`) as NonNullable<LevelDefinition['story']>['introKey'];
    }
    if (raw.story.outroKey !== undefined) {
      story.outroKey = str(raw.story.outroKey, `${ctx}.story.outroKey`) as NonNullable<LevelDefinition['story']>['outroKey'];
    }
    if (raw.story.realLayerKey !== undefined) {
      story.realLayerKey = str(raw.story.realLayerKey, `${ctx}.story.realLayerKey`) as NonNullable<LevelDefinition['story']>['realLayerKey'];
    }
    level.story = story;
  }

  return level;
}
