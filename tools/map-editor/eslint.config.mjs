/**
 * eslint.config.mjs — map-editor lint, flat config.
 *
 * New on 2026-08-26, together with server/'s: until then `client/` was the only package in the repo
 * with a linter at all (and it had been broken and unwatched for long enough that nobody knew — see
 * claudedocs/client-testing.md). Every tool had `typecheck` and `test` and no `lint` at all.
 *
 * The rules live in ../../eslint.shared.mjs, shared with client/ and server/. Plugins are imported
 * here rather than there because plugin resolution follows the importing file, and each tool has its
 * own node_modules.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import { sharedRules, sharedIgnores } from '../../eslint.shared.mjs';

export default [
  { ignores: sharedIgnores },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: sharedRules({ js, tseslint, prettierConfig }),
  },
];
