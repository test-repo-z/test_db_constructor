// ESLint flat config: the recommended rules plus a few that catch real bugs in this code base.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'benchmarks/results/', 'coverage/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // Progressive-enhancement script that runs in the browser.
    files: ['src/public/js/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
