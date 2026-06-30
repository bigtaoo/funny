// Re-export shim — this module's real source lives in @nw/engine (SLG_DESIGN §16.7).
// Equipment → blueprint injection (EQUIPMENT_DESIGN §9, E1). Client and tests deep-import through this shim; the source is byte-identical to the server-side copy.
export * from '@nw/engine/balance/equipment';
