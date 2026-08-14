import { defineConfig } from 'vitest/config';

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
  },
});
