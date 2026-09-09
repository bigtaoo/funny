/**
 * eslint.config.mjs — lint for all 13 server workspaces, from one config.
 *
 * New on 2026-08-26. Until then `client/` was the only package in the repo with a linter at all:
 * server/ (metaserver, gateway, matchsvc, gameserver, commercial, worldsvc, admin, analyticsvc,
 * socialsvc, auctionsvc, botsvc, shared, and @nw/engine — the numerical authority) had no config
 * and no `lint` script. Reviving client's lint made that the more interesting gap: the rules were
 * being enforced on the UI layer and nowhere near the money, match, or simulation code.
 *
 * One config for all workspaces rather than 13, because server/ is an npm-workspaces root: a
 * single `eslint` install at this level resolves for every package under it, and one file means
 * the rule decisions cannot drift per service. The rules themselves are shared with client/ and
 * tools/* in ../eslint.shared.mjs.
 *
 * Scope is each workspace's own src tree — same as client's `eslint src`. Test files are
 * deliberately out for now:
 * they are a different linting problem (fixtures legitimately hold half-built objects, and
 * `typecheck:test` already type-checks them), and pulling ~600 test files in at the same time as
 * the first-ever run on src would have buried the src findings. One exception since 2026-09-09: a
 * single-rule block bans a test file from importing its own package's `dist/`, because that mistake
 * is invisible in a green run and silently understates the coverage of the file being tested.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import { sharedRules, sharedIgnores } from '../eslint.shared.mjs';

export default [
  {
    ignores: [
      ...sharedIgnores,
      // Emitted by scripts/gen-routes.mjs from contracts/openapi.yml — a fix here is gone on
      // the next codegen run.
      '*/src/generated/**',
    ],
  },
  {
    files: ['*/src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: sharedRules({ js, tseslint, prettierConfig }),
  },
  {
    // Test files are otherwise out of lint scope (see the header) — this one rule is the exception,
    // because the convention it enforces was written down in ~30 test-file headers and drifted
    // anyway. A test that imports its own package's `../dist/*.js` runs the right code (`npm test` is
    // `tsc -b && vitest run`, so dist is never stale) but v8 attributes the coverage to the file it
    // actually loaded, so the src file the suite exercises reads as untested. metaserver carried 34
    // such files from the 2026-08 coverage rollout to 2026-09-09; converting them moved five modules
    // from 53-86% to 90-100% line coverage without touching a single assertion, and one of them
    // (src/apple/webhookRoute.ts, a thorough 9-case suite) had been reading 25%. The 90% gate cannot
    // tell that apart from no tests at all, and "pick the lowest package and backfill it" chooses
    // its targets from exactly these understated numbers.
    // Only the OWN-package form is banned. `../../<pkg>/dist/*` (admin/test/comp-mail.e2e.test.ts,
    // metaserver/test/mail-claim.e2e.test.ts) is a cross-service wire test importing another
    // workspace's build output: that package's coverage is measured by its own test run, so nothing
    // is hidden. See claudedocs/server-testing-coverage.md.
    files: ['*/test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    // The plugin is registered but none of its rules are enabled: test files carry
    // `eslint-disable @typescript-eslint/*` comments written for the src config, and an unregistered
    // plugin turns each of those into a "Definition for rule was not found" error. For the same
    // reason unused-disable reporting is off here — a directive that is unused under THIS block's
    // one rule is still doing its job under the src block.
    plugins: { '@typescript-eslint': tseslint },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../dist/*', '../../dist/*'],
              message:
                "Import the source ('../src/...'), not this package's own build output: v8 attributes coverage to the file it loaded, so a dist import makes the src file it exercises read as untested.",
            },
          ],
        },
      ],
    },
  },
  {
    // metaserver-only (2026-09-07): `app.log.*` type-checks, runs, and goes nowhere. index.ts builds
    // Fastify with `logger: false` and logs requests through a @nw/shared onResponse hook instead, so
    // Fastify's own logger is a no-op in production — every route-level app.log call is discarded
    // without a warning from the compiler or the runtime. Two routes had been writing "for CS/refund
    // lookup" warnings about failed real-money grants into that void; a silently unverified Apple IAP
    // payload went unnoticed the same way. Nothing marks the trap at the call site, so the linter does.
    // Scoped to metaserver because it is the only service that disables the Fastify logger; if another
    // one ever does, widen this. Test files are out of lint scope anyway (see the header), which is
    // where the `logger: true` builds live — those are free to keep using app.log.
    files: ['metaserver/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='app'][property.name='log']",
          message:
            "metaserver runs Fastify with `logger: false`, so app.log.* output is discarded. Use a module-level `const log = createLogger('meta:<area>')` from @nw/shared instead.",
        },
      ],
    },
  },
];
