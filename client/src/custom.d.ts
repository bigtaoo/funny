declare module '*.png';
declare module '*.ogg';
declare module '*.tao' { const url: string; export default url; }

// NOTE: no `declare module '*.json'` — let `resolveJsonModule` type JSON imports
// as their parsed object shape. Campaign levels (campaign/levels/*.json) are
// imported as data and validated by parseLevelDefinition, not loaded as URLs.
