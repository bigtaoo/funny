// Build-time stand-in for the npm `url` package (Node's legacy `url` module, browserified) on EVERY
// target, aliased in webpack.config.js `resolve.alias['url$']`.
//
// Why it is in the bundle at all: `@pixi/utils/lib/url.mjs` does `import { parse, format, resolve }
// from "url"` so it can hand them out through `PIXI.utils.url` — a getter object deprecated since
// PixiJS 7.3.0 ("use native URL API instead") that nothing in PixiJS itself reads any more. Static
// imports put the whole polyfill in the graph regardless: `url` + its own `punycode` + `qs` came to
// ~75 KB of the minified entry for code no frame of this game ever runs.
//
// Behaviour is identical as long as nobody reads `PIXI.utils.url.*` — that is the contract, and
// test/nodeUrlStub.test.ts pins it from both ends (no PixiJS module other than @pixi/utils/lib/url.mjs
// imports `url`, and no client source touches `utils.url`). If a call ever appears anyway, these
// throw with a pointer here instead of returning something subtly wrong.

function unavailable(name: string): never {
  throw new Error(
    `url.${name}() is stubbed out of the client bundle (src/platform/stubs/nodeUrl.ts); use the WHATWG URL API.`,
  );
}

export function parse(): never {
  return unavailable('parse');
}

export function format(): never {
  return unavailable('format');
}

export function resolve(): never {
  return unavailable('resolve');
}
