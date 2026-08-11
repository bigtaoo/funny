// Resolve each player's card draw policy at match setup — verbatim extract of
// engine/base.ts's old constructor (loadout/ban filters + PvE-only level spells +
// tutorial scripted draw, or the PvP/netplay per-side deck filter).
import { CARD_DEFINITIONS, SPELL_CARD_DEFS } from '../../config';
import { UniformCardDrawPolicy, TutorialDrawPolicy } from '../../Card';
import { TUTORIAL_LEVEL_ID, TUTORIAL_TEACHING_CARDS } from '../../campaign/tutorial';
import { Prng } from '../../math/prng';
import type { GameState } from '../../GameState';
import type { LevelDefinition } from '../../campaign/LevelDefinition';
import type { CardDefinition, GameConfig } from '../../types';

/**
 * Loadout / banned cards + level spells (§4.7, §4.9.2) for a campaign/siege level.
 * Builds a unified card pool for the bottom player's draw policy that respects
 * loadout/ban filters and includes any PvE-only spell cards. Returns the spell cards
 * to force-inject into the opening hand (EngineCtx.initialSpellCards); empty when the
 * level has no loadout/ban/levelSpells (bottomPlayer.drawPolicy is left at its
 * GameState-constructed default in that case, same as before).
 */
export function applyPveDrawPolicy(state: GameState, level: LevelDefinition, seed: number): CardDefinition[] {
  const { loadout, bannedCards, levelSpells } = level;
  const loadoutSet = loadout     ? new Set(loadout)     : null;
  const bannedSet  = bannedCards ? new Set(bannedCards) : null;
  const needsCustomPolicy = loadoutSet || bannedSet || (levelSpells && levelSpells.length > 0);
  if (!needsCustomPolicy) return [];

  const pool = (CARD_DEFINITIONS as readonly CardDefinition[]).filter((c) => {
    if (loadoutSet && !loadoutSet.has(c.id)) return false;
    if (bannedSet  && bannedSet.has(c.id))   return false;
    return true;
  });

  // Append spell card defs to the draw pool so they appear in refreshes too.
  const spellDefs: CardDefinition[] = [];
  const initialSpellCards: CardDefinition[] = [];
  if (levelSpells) {
    for (const { cardId, initialCount } of levelSpells) {
      const def = SPELL_CARD_DEFS.get(cardId);
      if (!def) throw new Error(`levelSpells: unknown spell card '${cardId}'`);
      spellDefs.push(def);
      for (let i = 0; i < initialCount; i++) initialSpellCards.push(def);
    }
  }
  const finalPool = pool.length > 0 || spellDefs.length > 0
    ? [...pool, ...spellDefs]
    : undefined;

  // Use a separate PRNG so loadout levels are deterministic and don't disturb levels
  // that draw from the full CARD_DEFINITIONS pool.
  const drawPrng = new Prng(seed ^ 0xC0FFEE00);
  if (level.id === TUTORIAL_LEVEL_ID) {
    // Dedicated tutorial level: scripted draw so the cap-point director always finds the
    // teaching cards in order (ONBOARDING_DESIGN §3.3). The filler pool is the loadout
    // minus the teaching cards so a played teaching card never refills into another
    // teaching card. Stage C swaps this back to a UniformCardDrawPolicy in the
    // render-layer director.
    const teach: CardDefinition[] = [];
    for (const id of TUTORIAL_TEACHING_CARDS) {
      const def = pool.find((c) => c.id === id);
      if (def) teach.push(def);
    }
    const teachSet = new Set<string>(TUTORIAL_TEACHING_CARDS);
    const filler = pool.filter((c) => !teachSet.has(c.id));
    state.bottomPlayer.drawPolicy = new TutorialDrawPolicy(teach, filler, drawPrng);
  } else {
    state.bottomPlayer.drawPolicy = new UniformCardDrawPolicy(drawPrng, finalPool);
  }

  return initialSpellCards;
}

/**
 * PvP/netplay dual draw policy (PVP_LOADOUT_DESIGN §6.1–6.2). When the server supplies
 * deck lists, replace each player's default full-pool policy with a filtered one. Fresh
 * PRNG instances use the same seed derivation as GameState so both clients produce
 * byte-identical draw sequences for each side regardless of network arrival order.
 */
export function applyPvpDeckPolicy(state: GameState, config: GameConfig): void {
  if (!config.decks) return;
  const buildDeckPolicy = (deckIds: string[], seed: number) => {
    const deckSet = new Set(deckIds);
    const pool = (CARD_DEFINITIONS as readonly CardDefinition[]).filter((c) => deckSet.has(c.id));
    const prng = new Prng(seed);
    return new UniformCardDrawPolicy(prng, pool.length > 0 ? pool : undefined);
  };
  state.bottomPlayer.drawPolicy = buildDeckPolicy(config.decks.bottom, config.seed);
  state.topPlayer.drawPolicy    = buildDeckPolicy(config.decks.top,    config.seed ^ 0xdeadbeef);
}
