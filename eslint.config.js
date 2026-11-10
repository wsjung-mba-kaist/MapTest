// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint for correctness only. The repo's deliberate dense single-line style (several statements per line, long lines,
 * `a = b, c = d` declarations) is not a lint concern, so every stylistic rule that would fight it stays off; what is
 * enforced here are the project's own contracts from CLAUDE.md: shared/ stays free of three.js and the DOM, URL
 * parameters are read in one place, and promises are not dropped on the floor.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'public/**', 'cache/**', 'smoke/**', 'node_modules/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    // two tsconfigs (Bundler for src, NodeNext for scripts); shared/ is in both and resolves through the first
    languageOptions: { parserOptions: { project: ['./tsconfig.json', './tsconfig.scripts.json'], tsconfigRootDir: import.meta.dirname } },
    rules: {
      // the codebase leans on these on purpose (hot-loop `!` on known-present attributes, `_unused` params)
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'prefer-const': ['error', { destructuring: 'all' }],
      // a forgotten `await` on a loader silently produces a half-built world
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    // shared/ is compiled under both tsconfigs and must not pull in the browser or three.js (CLAUDE.md)
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ['three'], patterns: ['three/*', '../src/*'] }],
      'no-restricted-globals': ['error', 'window', 'document', 'localStorage', 'navigator'],
    },
  },
  {
    // URL flags are parsed by App (and the few modules the README documents); new readers belong there too
    files: ['src/**/*.ts'],
    ignores: ['src/core/App.ts'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "NewExpression[callee.name='URLSearchParams'] > MemberExpression[object.name='location'][property.name='search']",
        message: 'URL parameters are parsed once by App (shared/urlparams.ts is the registry); pass the value in, do not read location.search here.',
      }],
    },
  },
  {
    // every stored key is listed in src/ui/storage.ts, so "reset to defaults" can clear all of them
    files: ['src/**/*.ts'], ignores: ['src/ui/storage.ts'],
    rules: { 'no-restricted-globals': ['error', { name: 'localStorage', message: 'Use the helpers in src/ui/storage.ts (keys are registered there).' }] },
  },
  // node:test's `test()` returns a promise that the runner collects itself
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-floating-promises': 'off' } },
);
