declare module '*.png';
declare module '*.ogg';
// Audio (AUDIO_DESIGN.md §2): typed like '*.tao' rather than the bare '*.png'/'*.ogg' forms
// above, so `import u from './x.mp3'` gives a `string` URL instead of `any` — cueAssets.ts
// stores those URLs in a typed map and an `any` there would erase the whole check.
declare module '*.mp3' { const url: string; export default url; }
declare module '*.tao' { const url: string; export default url; }

// NOTE: no `declare module '*.json'` — let `resolveJsonModule` type JSON imports
// as their parsed object shape. Campaign levels (campaign/levels/*.json) are
// imported as data and validated by parseLevelDefinition, not loaded as URLs.
