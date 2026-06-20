// Re-export shim — this module's real source moved to @nw/engine (SLG_DESIGN §16.7).
// Kept so existing deep imports (`../game/systems/CombatSystem`, tests' `../src/game/systems/CombatSystem`) stay verbatim.
export * from '@nw/engine/systems/CombatSystem';
