import path from 'path';
import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Phase 1-3 covered the editor's PURE logic layer (see claudedocs/animator.md's 2026-08-13 notes
// on scope): units.ts (display metadata) + state/EditorState.ts (the level-editing state
// machine). Phase 4 (2026-08-13, tools-test-coverage-plan memory) extracted+exported the pure
// coordinate-transform/hit-test/tint math out of board/BoardPanel.ts and timeline/TimelinePanel.ts
// (rowToY/cellAt/laneHeaderAt/cellCenter/hitHandle/baseTint; tickToX/xToTick/laneIndex/
// yToLaneIndex/entryEndTick/hitTest) as free functions taking cell/header/pxPerSec/scrollX
// explicitly instead of reading `this` — note board/*+timeline/* never actually used PIXI (this
// editor has none as a dependency at all), only raw `canvas.getContext('2d')`. The PANEL CLASSES
// themselves (construction, rendering, drag/drop wiring) and index.ts/inspector/* remain out of
// scope: those build a real `<canvas>`/ResizeObserver/window listeners at construction time, and
// this editor has no headless-DOM harness like client/test/harness/pixiHeadless.ts.
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
      // ADR-070 (2026-08-20): the machine-readable form of the scope described in prose above.
      // 100% (216/216) as of 2026-08-20 — but read that number next to the whole-package one the
      // root report prints beside it (23.8%), because this scope is only 216 of the tool's ~1670
      // lines. A gate over 13% of a package is thin, and this is the narrowest scope of the five
      // tools, which is exactly why ADR-070's Phase 4b widens it: board/BoardPanel.ts and
      // timeline/TimelinePanel.ts already hold pure exported coordinate/hit-test math
      // (rowToY/cellAt/laneHeaderAt/cellCenter/hitHandle/baseTint, tickToX/xToTick/laneIndex/
      // yToLaneIndex/entryEndTick/hitTest), extracted in Phase 4 back in 2026-08-13 but still
      // living inside the canvas-owning panel classes, so no directory include can reach them.
      // Moving them into their own modules is the point of Phase 4b; then they come in here.
      include: ['src/state/**', 'src/units.ts'],
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
