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
 * the first-ever run on src would have buried the src findings.
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
];
