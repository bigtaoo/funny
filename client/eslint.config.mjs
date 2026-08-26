/**
 * eslint.config.mjs — client lint, flat config.
 *
 * Replaces `.eslintrc.js`, which ESLint stopped reading at v9 (installed here: 10.x). `npm run
 * lint` had therefore been failing at startup — "couldn't find an eslint.config.(js|mjs|cjs)" —
 * and no CI step invoked it, so nothing reported it. Two things to know before trusting this file:
 *
 *   1. There was no backlog of violations to grind through, because the linter never ran long
 *      enough to have an opinion. What it found on first run was 224 errors, and every one was
 *      either dead code or a rule that needed a decision — not a codebase in disrepair. The
 *      largest single cluster was 76 unused imports in `scenes/worldmap/WorldMapInput.ts`, left
 *      behind when that file was split into `WorldMapInput/*.ts`; exactly the kind of thing a
 *      working gate keeps from accumulating.
 *   2. The old config's one piece of real value — banning Math.random() / Date.now() / new Date()
 *      in the game logic layer — pointed at `src/game/GameEngine.ts`, `src/game/systems/**`,
 *      `src/game/math/**` and five sibling files. ALL of those were deleted on 2026-08-02, when
 *      the engine moved out to `server/engine/src` (@nw/engine). So even had the linter run, that
 *      override would have matched nothing since. It is deliberately not reproduced here — the
 *      code it guards is not in this package any more. The gate moved to a source scan over the
 *      engine's real location: `client/test/engineDeterminism.test.ts`, in a suite CI already runs.
 *
 * The rules themselves live in ../eslint.shared.mjs, shared with server/ and every tools/*.
 *
 * Prettier is deliberately NOT a lint rule here. The old config extended
 * `plugin:prettier/recommended`, but `eslint-plugin-prettier` is pinned at 4.2.5, which predates
 * flat config; and running a formatter through the linter is slow and something Prettier itself
 * advises against. `npm run format` already owns formatting. `eslint-config-prettier` is still
 * applied, purely to switch off the stylistic core rules that would argue with it.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import { sharedRules, sharedIgnores } from '../eslint.shared.mjs';

export default [
  {
    // Generated output and build artifacts are not ours to lint: the OpenAPI/proto clients are
    // emitted by scripts/gen-*.mjs and would be rewritten over any fix applied here.
    ignores: [...sharedIgnores, 'src/net/openapi*.ts', 'src/net/proto/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: sharedRules({ js, tseslint, prettierConfig }),
  },
  {
    // Ambient declaration files for a third-party SDK (`src/wx.d.ts`, the WeChat mini-game API)
    // mirror shapes we do not control: `{}` and `Function` appear in the vendor's own surface,
    // every declared parameter is "unused" by definition, and `declare module X` is how the SDK
    // namespaces itself. Enforcing these here would mean rewriting someone else's API surface to
    // satisfy a linter, which is how typings drift away from the thing they describe.
    files: ['**/*.d.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/prefer-namespace-keyword': 'off',
    },
  },
];
