import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Tests cover the ops admin console's PURE layer and its REST client:
//   src/logic/**  — one module per page (plus shared.ts and nav.ts): the queries each form builds,
//                   the validation, the pivots and shares behind every analytics table, which
//                   buttons a comp ticket or an SLG world offers, and every derived label/pill.
//   src/api/**    — the endpoint surface (index.ts) over the transport half (transport.ts): URL and
//                   query-string construction, response unwrapping, and the error/401 mapping.
// Out of scope, deliberately: src/pages/** and src/app.ts build plain DOM directly against
// `document`/`window` at call time (not just import time, unlike map-editor's dom.ts) and assume a
// real browser fetch/localStorage session — the same headless-DOM-harness gap the four sibling tools
// have. src/dom.ts is the `h()` helper itself; src/types.ts is type-only (zero measured lines).
//
// `fmtTime` stays in src/dom.ts rather than moving into the pure layer even though it takes no DOM:
// its output is `Date#toLocaleString`, i.e. locale- and timezone-dependent, so a test could only
// assert it equals `new Date(ms).toLocaleString()`. The '—' branch for a falsy timestamp is the only
// decision in it, and the pure functions that build a sentence AROUND a timestamp take the formatter
// as a parameter (logic/flags.ts flagMetaText and friends) so those sentences stay testable.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // ADR-070 Phase 4e (2026-08-20): the machine-readable form of the prose scope above, and the
      // last of the five tools to graduate into the 90% gate (the package moved from
      // NOT_GATED_JSON_SUMMARY_PACKAGES into JSON_SUMMARY_PACKAGES in scripts/coverageLib.mjs).
      //
      // What used to be here was NOTHING — this package reported its whole self, 8.84% (322/3639),
      // the worst number in the repo, on purpose: the nine pure helpers Phase 3 (2026-08-13) had
      // exported each still lived inside a `pages/*.ts` file whose other 90% was `h()`-built DOM, so
      // there was no directory to point at, and scoping to `src/api/**` or `!src/pages/**` would have
      // moved the printed number without moving a single test. Phase 4e did the structural half
      // first: the per-page pure logic now lives in src/logic/<page>.ts and pages/* is DOM assembly.
      // src/api.ts became src/api/index.ts in the same pass, so that `src/api/**` covers the endpoint
      // surface too instead of needing a per-file entry beside it.
      //
      // The boundary itself is pinned by test/pureLayerBoundary.test.ts, NOT by this percentage. The
      // gate's headroom is `covered/0.9 - total`, which is dozens of lines here and GROWS as these
      // tests improve, so a small 0%-covered DOM file dropped into src/logic/ would land inside an
      // included directory and leave the gate green (measured on both sibling tools: map-editor 13
      // lines → 96.98% and passing, level-editor 10 lines → 97.8% and passing). That guard derives
      // its directory list from this very include list, so adding a third entry here fails until it
      // is classified — and it holds src/logic/** and src/api/** to DIFFERENT rules, because the
      // transport layer legitimately needs fetch/localStorage/location while the logic layer must
      // touch no global at all.
      include: ['src/logic/**', 'src/api/**'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
