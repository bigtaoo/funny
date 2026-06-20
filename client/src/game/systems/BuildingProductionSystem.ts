// Re-export shim — this module's real source moved to @nw/engine (SLG_DESIGN §16.7).
// Kept so existing deep imports (`../game/systems/BuildingProductionSystem`, tests' `../src/game/systems/BuildingProductionSystem`) stay verbatim.
export * from '@nw/engine/systems/BuildingProductionSystem';
