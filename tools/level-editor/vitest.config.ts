import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Tests cover the editor's PURE layers only: units.ts (display metadata), state/EditorState.ts
// (the level-editing state machine), and layout/{board,timeline}.ts (screen geometry, hit-testing,
// the zone/lane palettes, path polylines, and the drag-snap + pan/zoom arithmetic for the two
// canvas panels). Anything that owns a `<canvas>` or touches the DOM — board/BoardPanel.ts,
// timeline/TimelinePanel.ts, inspector/*, index.ts — is deliberately out of scope: those build a
// real `<canvas>`/ResizeObserver/window listeners at construction time, and this editor has no
// headless-DOM harness like client/test/harness/pixiHeadless.ts. (It has no PIXI either — the
// panels draw with raw `canvas.getContext('2d')`; the barrier here is the DOM, not a renderer.)
//
// Alias mirrors webpack.config.js + tsconfig.json's `@nw/engine` path.
export default defineConfig({
  resolve: {
    alias: {
      '@nw/engine': path.resolve(__dirname, '../../server/engine/src'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // ADR-070 (2026-08-20): the machine-readable form of the prose scope above. 100.0%
      // (445/445) lines and 64/64 functions as of 2026-08-20, and every covered line in the whole
      // package falls inside this list — the scope matches what the suite actually exercises
      // rather than being drawn around it after the fact. The uncovered BRANCHES that remain
      // (EditorState's normalize guards, timeline.ts's `meta.label || meta.type` fallback, which
      // units.ts's own String(type) fallback makes unreachable) are pinned in the tests that
      // document them; the gate is on lines only, by long-standing convention (see
      // checkCoverageThreshold.mjs's header).
      //
      // Phase 4b (same day) made this list purely directory/whole-file level and put the package
      // under the 90% gate (it moved from NOT_GATED_JSON_SUMMARY_PACKAGES up into
      // JSON_SUMMARY_PACKAGES in scripts/coverageLib.mjs). What used to be here was
      // `['src/state/**', 'src/units.ts']` — 216 of the tool's ~1670 lines, the narrowest scope of
      // the five tools — because the pure coordinate/hit-test math, although Phase 4 (2026-08-13)
      // had already exported it, still lived INSIDE the canvas-owning panel classes, where no
      // directory include can reach it without dragging in the drawing code. That math, plus the
      // pure decisions still buried in resize()/onMove()/onWheel() and the draw methods, now lives
      // in src/layout/{board,timeline}.ts, and src/board/ + src/timeline/ are uniformly the DOM
      // half. ADR-070's table estimated this would widen the scope to ~600 lines; measured, it is
      // 445 — the rest of those two files is drawing code, which is the DOM half by definition.
      // Out of scope: board/*, timeline/*, inspector/*, index.ts.
      //
      // The boundary itself is pinned by test/pureLayerBoundary.test.ts, NOT by this percentage.
      // The gate's headroom is `covered/0.9 - total` = 49 lines here, so a 0%-covered DOM file
      // smaller than that lands inside an included directory and the gate stays GREEN. Verified by
      // actually dropping a 10-line DOM probe into src/layout/: coverage 97.8% (445/455), gate
      // PASSES, while pureLayerBoundary.test.ts goes red on it. None of this package's five
      // out-of-scope files happens to be that small today (196-477 lines), so moving an EXISTING
      // one in really would fail the gate — but that is an accident of their size, not a property
      // of the gate, and the headroom GROWS as these tests improve. pureLayerBoundary.test.ts
      // derives the directories it checks from this very include list, so adding a third one here
      // fails until it is guarded too.
      include: ['src/state/**', 'src/layout/**', 'src/units.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
