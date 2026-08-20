import { defineConfig, coverageConfigDefaults } from 'vitest/config';

// Phase 1 was bootstrap-only (see claudedocs/animator.md's 2026-08-13 note on scope): just the
// ops admin console's PURE ms<->datetime-local helpers (pages/shared.ts). Phase 3 (2026-08-13,
// see tools-test-coverage-plan memory) extracted+exported one or two PURE helper functions out
// of several `pages/*.ts` files (formatting/status/draft-state calcs with no `h()`/DOM touch —
// e.g. pvpBalance.winRate, gachaPools.{emptyDraft,draftFromPool,poolStatus}, events.eventStatus,
// tickets.{describeTarget,describeAttachments}, flags.parseList, appeals.fmtSnapshot,
// suspicions.fmtStats, analytics.pct) and added a same-named test file per page. The page-render
// functions themselves and every row/card builder remain plain-DOM built directly against
// `document`/`window` at call time (not just import time, unlike map-editor's dom.ts), and still
// assume a real browser fetch/localStorage session — still out of scope.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      // ADR-070 (2026-08-20): the four sibling tools each scope `coverage.include` to their pure
      // logic layer. ops deliberately does NOT, and reports the whole package instead — 8.84%
      // (322/3639) as of 2026-08-20, the worst number in the repo by a wide margin.
      //
      // That is the honest reading, not an oversight. This console has no logic layer to point at:
      // Phase 3 (2026-08-13) exported nine pure helpers for testing, but each one still lives
      // inside the `pages/*.ts` file whose other 90% is `h()`-built DOM, so there is no directory
      // — and no useful per-file list either — that isolates logic from rendering. The largest
      // non-page file, src/api.ts, is itself only 22.7%. Scoping to `src/api/**` or
      // `!src/pages/**` would move the printed number without moving a single test, which is the
      // one thing a coverage gate must never reward.
      //
      // ADR-070's Phase 4e is the fix: lift the per-page pure logic into `src/logic/<page>.ts`
      // (leaving pages/* as DOM assembly, the same direction as f22c3df2's api.ts/types.ts split),
      // then this becomes `include: ['src/logic/**', 'src/api/**']` like its siblings.
      exclude: [...coverageConfigDefaults.exclude],
    },
  },
});
