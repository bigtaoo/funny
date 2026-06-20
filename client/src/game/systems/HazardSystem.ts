// Re-export shim — this module's real source moved to @nw/engine (SLG_DESIGN §16.7).
// Kept so existing deep imports (`../game/systems/HazardSystem`, tests' `../src/game/systems/HazardSystem`) stay verbatim.
export * from '@nw/engine/systems/HazardSystem';
