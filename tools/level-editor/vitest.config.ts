import path from 'path';
import { defineConfig } from 'vitest/config';

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
  },
});
