// tileGraphics — pure PIXI drawing primitives for the world map. Barrel re-export over the
// tileGraphics/ split (tiles / resources / primitives) so every existing import of
// `from './tileGraphics'` (or the relative test path) keeps working unchanged. See
// claudedocs/client-modules.md for the split-form① convention this follows.
export * from './tileGraphics/tiles';
export * from './tileGraphics/resources';
export * from './tileGraphics/primitives';
