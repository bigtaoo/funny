// Re-export shim — this module's real source moved to @nw/engine (SLG_DESIGN §16.7).
// Kept so existing deep imports (`../game/systems/MovementSystem`, tests' `../src/game/systems/MovementSystem`) stay verbatim.
export * from '@nw/engine/systems/MovementSystem';
