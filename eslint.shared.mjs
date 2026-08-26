/**
 * eslint.shared.mjs — the one copy of this repo's lint decisions.
 *
 * Imported by every package's own `eslint.config.mjs` (`client/`, `server/`, and each
 * `tools/*`). It deliberately imports NOTHING itself: ESLint plugins resolve relative to the
 * file that imports them, and these packages have separate `node_modules` trees, so a shared
 * file with its own `import tseslint from ...` would resolve out of whichever directory it
 * happens to sit in. Instead each package imports its own plugin objects and passes them in.
 *
 * History worth keeping: `npm run lint` existed in client/ for a long time and had been
 * failing at startup since ESLint 9 stopped reading `.eslintrc.js`; no CI step ran it, so
 * nothing reported it (2026-08-26, see claudedocs/client-testing.md). When it was revived it
 * turned out to be the ONLY linter in the repo — server/ (13 workspaces, including @nw/engine,
 * the numerical authority) and all five tools/ had no lint config and no lint script at all.
 * This file exists so extending the gate to them did not mean copy-pasting five subtly
 * diverging rule sets.
 */

/**
 * Merge the `rules` out of a typescript-eslint flat preset. The presets are not uniformly
 * shaped — `flat/recommended` is an array of config objects, `flat/eslint-recommended` a
 * single one — so normalise before merging. Only `rules` is taken: parser, plugin
 * registration and `files` scoping stay with the consuming package's own config.
 */
export const tsPresetRules = (tseslint, preset) =>
  [tseslint.configs[preset]].flat().reduce((acc, c) => ({ ...acc, ...c.rules }), {});

/**
 * The shared rule set. Pass the importing package's own plugin/config objects:
 *
 *   rules: { ...sharedRules({ js, tseslint, prettierConfig }) }
 */
export function sharedRules({ js, tseslint, prettierConfig }) {
  return {
    ...js.configs.recommended.rules,
    ...tsPresetRules(tseslint, 'flat/eslint-recommended'),
    ...tsPresetRules(tseslint, 'flat/recommended'),
    ...prettierConfig.rules,

    // The codebase already has a convention for "this argument exists to satisfy a signature
    // and is deliberately not read" — prefix it with `_` (`_dt` on every update(), `_winner`/
    // `_stats`/`_replay` on game-over callbacks, `_accountId` on platform stubs, `_x`/`_y` on
    // pointer handlers that only care that a tap happened). 24 of the client's first-run
    // unused-var errors were exactly that, i.e. the rule disagreeing with an existing
    // convention rather than finding anything. Teach it the convention instead of renaming a
    // hundred parameters.
    // `ignoreRestSiblings` is the object-rest half of the same story: `({ accountId, ...rest }) =>
    // rest` is how you omit a field, and the omitted name is by definition never read. socialsvc's
    // family/query.ts uses exactly that to strip accountId from member rows for non-members — a
    // privacy strip, not dead code — so flagging it would be the rule misreading the idiom.
    '@typescript-eslint/no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      ignoreRestSiblings: true,
    }],

    // `const view = this` / `const core = this` / `const scene = this` — a consistent house
    // idiom for giving `this` a readable name inside a closure or a nested object literal
    // (HUDView, CityScene/core, SettingsScene, TutorialDirector, UnitView, ...). The rule
    // exists to catch the pre-arrow-function `var self = this` workaround, which this is not:
    // these files use arrow functions throughout and alias for legibility, not to capture scope.
    '@typescript-eslint/no-this-alias': 'off',

    // Off, and not for convenience: the rule's premise ("a store nothing reads afterwards is
    // waste") is wrong for the two shapes all of its hits had.
    //   - Loop accumulators. `cy += rowH` as the last statement of a row loop is flagged
    //     because the FINAL iteration's store is never read — but the other N-1 iterations do
    //     read it. Deleting it breaks the loop; keeping it is not waste.
    //   - Defensive initialisers. `let seed = 0` / `let cred = null` followed by assignment in
    //     every branch of a try/catch. The initialiser documents the fallback and often keeps
    //     TS's definite-assignment analysis happy; dropping it trades one redundant store for
    //     a compile error.
    // Both are load-bearing for maintenance: a trailing cursor advance is what makes appending
    // the next row correct by default.
    'no-useless-assignment': 'off',

    // `ignoreReadBeforeAssign` is the option this rule ships for exactly the shape vfx-editor's
    // index.ts has: `let effectList: EffectListPanel;` declared BEFORE the Library that closes over
    // it, assigned right after (`() => void effectList?.refresh()` — the `?.` is the guard against
    // the callback firing early). The rule is technically right that it is assigned once; taking its
    // advice means either a TDZ throw if that callback ever fires during construction, or reordering
    // code whose order is the point. Everything else prefer-const catches still fails.
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],

    // Error, with no exemptions. It started as a warning in client/ on the reasoning that its
    // hits were untyped third-party interop where a hand-written type would be fiction — which
    // was wrong: they were `JSON.parse(...) as any` over `.tao` bundles, OUR own format, whose
    // writer (tools/animator/src/io/taoExport.ts) had been fully typed all along. The reader
    // was discarding a contract that already existed. See client/src/render/stickman/
    // taoFormat.ts. The generalisable part: "a type here would be fiction" is worth checking
    // against who writes the data before believing it — inside this repo the answer is usually
    // "we do".
    '@typescript-eslint/no-explicit-any': 'error',
  };
}

/**
 * Paths no package should lint: build output, coverage reports, and generated clients. The
 * generated ones matter most — `scripts/gen-*.mjs` and the OpenAPI/proto codegen rewrite them
 * wholesale, so a fix applied there is gone on the next run.
 *
 * `coverage/**` is on this list for a reason worth writing down: istanbul's HTML report ships
 * its own vendored `prettify.js` / `sorter.js` / `block-navigation.js`, each carrying an
 * `/* eslint-disable *\/` header. ESLint lints `.js` by default and reports every disable
 * directive that suppresses nothing — so a first run without this entry produced 96 "unused
 * eslint-disable directive" warnings from coverage artifacts, swamping the 4 real ones in our
 * own source.
 */
export const sharedIgnores = [
  '**/node_modules/**',
  '**/dist/**',
  '**/coverage/**',
  '**/*.gen.ts',
  '**/generated/**',
];
