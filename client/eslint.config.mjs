/**
 * eslint.config.mjs — client lint, flat config.
 *
 * Replaces `.eslintrc.js`, which ESLint stopped reading at v9 (installed here: 10.x). `npm run lint`
 * had therefore been failing at startup — "couldn't find an eslint.config.(js|mjs|cjs)" — and no CI
 * step invoked it, so nothing reported it. Two things to know before trusting this file:
 *
 *   1. There was no backlog of violations to grind through, because the linter never ran long enough
 *      to have an opinion. What it found on first run was 224 errors, and every one was either dead
 *      code or a rule that needed a decision (see below) — not a codebase in disrepair. The largest
 *      single cluster was 76 unused imports in `scenes/worldmap/WorldMapInput.ts`, left behind when
 *      that file was split into `WorldMapInput/*.ts`; exactly the kind of thing a working gate keeps
 *      from accumulating.
 *   2. The old config's one piece of real value — banning Math.random() / Date.now() / new Date() in
 *      the game logic layer — pointed at `src/game/GameEngine.ts`, `src/game/systems/**`,
 *      `src/game/math/**` and five sibling files. ALL of those were deleted on 2026-08-02, when the
 *      engine moved out to `server/engine/src` (@nw/engine). So even had the linter run, that
 *      override would have matched nothing since. It is deliberately not reproduced here — the code
 *      it guards is not in this package any more. The gate moved to a source scan over the engine's
 *      real location: `client/test/engineDeterminism.test.ts`, in a suite CI already runs.
 *
 * Prettier is deliberately NOT a lint rule here. The old config extended `plugin:prettier/recommended`,
 * but `eslint-plugin-prettier` is pinned at 4.2.5, which predates flat config; and running a
 * formatter through the linter is slow and something Prettier itself advises against. `npm run
 * format` already owns formatting. `eslint-config-prettier` is still applied, purely to switch off
 * the stylistic core rules that would argue with it.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

/**
 * Collect just the `rules` out of a typescript-eslint flat preset. The presets are not uniformly
 * shaped — `flat/recommended` is an array of config objects while `flat/eslint-recommended` is a
 * single one — so normalise before merging. We take only the rules because the parser, plugin
 * registration and `files` scoping are set explicitly below.
 */
const tsRules = (preset) =>
  [tseslint.configs[preset]].flat().reduce((acc, c) => ({ ...acc, ...c.rules }), {});

export default [
  {
    // Generated output and build artifacts are not ours to lint: the OpenAPI/proto clients are
    // emitted by scripts/gen-*.mjs and would be rewritten over any fix applied here.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'src/net/openapi*.ts',
      'src/net/proto/**',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...js.configs.recommended.rules,
      ...tsRules('flat/eslint-recommended'),
      ...tsRules('flat/recommended'),
      ...prettierConfig.rules,

      // The codebase already has a convention for "this argument exists to satisfy a signature and
      // is deliberately not read" — prefix it with `_` (`_dt` on every update(), `_winner`/`_stats`/
      // `_replay` on game-over callbacks, `_accountId` on platform stubs, `_x`/`_y` on pointer
      // handlers that only care that a tap happened). 24 of the first run's 149 unused-var errors
      // were exactly that, i.e. the rule disagreeing with an existing convention rather than
      // finding anything. Teach it the convention instead of renaming a hundred parameters.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],

      // `const view = this` / `const core = this` / `const scene = this` — a consistent house idiom
      // for giving `this` a readable name inside a closure or a nested object literal (HUDView,
      // CityScene/core, SettingsScene, TutorialDirector, UnitView, ...). The rule exists to catch
      // the pre-arrow-function `var self = this` workaround, which this is not: these files use
      // arrow functions throughout and alias for legibility, not for scope capture.
      '@typescript-eslint/no-this-alias': 'off',

      // Off, and not for convenience: the rule's premise ("a store nothing reads afterwards is
      // waste") is wrong for the two shapes all 13 of its hits had.
      //   - Loop accumulators. `cy += rowH` as the last statement of a row loop is flagged because
      //     the FINAL iteration's store is never read — but the other N-1 iterations do read it.
      //     Deleting it breaks the loop; keeping it is not waste.
      //   - Defensive initialisers. `let seed = 0` / `let cred = null` followed by assignment in
      //     every branch of a try/catch. The initialiser documents the fallback and often keeps
      //     TS's definite-assignment analysis happy; dropping it trades one redundant store for a
      //     compile error.
      // Both are load-bearing for maintenance: a trailing cursor advance is what makes appending
      // the next row correct by default.
      'no-useless-assignment': 'off',

      // Error, with zero exemptions in src/ — no `eslint-disable` for it anywhere.
      //
      // It started as a warning (12 hits) on the reasoning that they were untyped third-party
      // interop where a hand-written type would be fiction. That reasoning was wrong, and it is
      // worth recording why: the 9 hits in `render/stickman/assetLoader.ts` were `JSON.parse(...)
      // as any` over `.tao` bundles — OUR OWN format, whose writer (`tools/animator/src/io/
      // taoExport.ts`) has been fully typed all along. JSZip is third-party; the JSON inside the
      // ZIP is not. So the reader was throwing away a contract that already existed on the writer
      // side: rename a field in taoExport.ts and nothing failed anywhere — the client read
      // `undefined` and fell back to a default. `src/render/stickman/taoFormat.ts` is now the
      // reader's half of that contract. The other 3 were a `(Skeleton as any)` static-init cast
      // (the animator's copy of the same file already had a readonly-stripping mapped type for
      // exactly this) and one `as any` on a computed i18n key where `as TranslationKey` is the
      // established house idiom elsewhere.
      //
      // The lesson generalises: "a type here would be fiction" is worth checking against who
      // writes the data before believing it. Inside this repo the answer is usually "we do".
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Ambient declaration files for a third-party SDK (`src/wx.d.ts`, the WeChat mini-game API)
    // mirror shapes we do not control: `{}` and `Function` appear in the vendor's own surface, every
    // declared parameter is "unused" by definition, and `declare module X` is how the SDK namespaces
    // itself. Enforcing these here would mean rewriting someone else's API surface to satisfy a
    // linter, which is how typings drift away from the thing they describe.
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
