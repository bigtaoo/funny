declare module '*.png';
declare module '*.ogg';
declare module '*.tao' { const url: string; export default url; }

declare module '*.json' {
  const url: string;
  export default url;
}
