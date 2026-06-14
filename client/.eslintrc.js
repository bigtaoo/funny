module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'prettier'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  rules: {
    'prettier/prettier': 'error',
  },

  overrides: [
    /**
     * ── Game Logic Layer — determinism enforcement ────────────────────────
     *
     * These rules apply ONLY to src/game/ logic files (NOT the old matching
     * game files like logic.ts / gameScene.ts, and NOT GameRunner.ts which
     * is the client adapter and deliberately uses float time).
     *
     * Banned:
     *   Math.random()  → use Prng from math/prng.ts
     *   Date.now()     → forbidden; seed must be supplied externally
     *   new Date()     → forbidden
     *
     * TypeScript's Fp branded type (math/fixed.ts) enforces fp arithmetic
     * at compile time. These ESLint rules catch the remaining runtime hazards.
     */
    {
      files: [
        'src/game/GameEngine.ts',
        'src/game/GameState.ts',
        'src/game/Board.ts',
        'src/game/Unit.ts',
        'src/game/Building.ts',
        'src/game/Player.ts',
        'src/game/Card.ts',
        'src/game/systems/**/*.ts',
        'src/game/math/**/*.ts',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          // ── Math.random() ──────────────────────────────────────────────
          {
            selector:
              'CallExpression[callee.type="MemberExpression"][callee.object.name="Math"][callee.property.name="random"]',
            message:
              '[logic-layer] Math.random() is non-deterministic. Use Prng from math/prng.ts instead.',
          },
          // ── Date.now() ─────────────────────────────────────────────────
          {
            selector:
              'CallExpression[callee.type="MemberExpression"][callee.object.name="Date"][callee.property.name="now"]',
            message:
              '[logic-layer] Date.now() is non-deterministic. Pass seed via GameConfig.seed.',
          },
          // ── new Date() ─────────────────────────────────────────────────
          {
            selector: 'NewExpression[callee.name="Date"]',
            message:
              '[logic-layer] new Date() is non-deterministic. Pass seed via GameConfig.seed.',
          },
        ],
      },
    },
  ],
};
