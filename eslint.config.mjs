import eslint from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', '.sites-runtime/**', '.sites-checkout/**'],
  },
  {
    files: ['site/**/*.{js,mjs}', 'static/**/*.js', 'tests/**/*.{js,mjs,cjs}', 'eslint.config.mjs'],
    ...eslint.configs.recommended,
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...globals.worker },
    },
    rules: {
      ...eslint.configs.recommended.rules,
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['site/**/*.js', 'static/**/*.js'],
    rules: {
      // These scripts share browser or Worker globals through an ordered build.
      'no-undef': 'off',
      'no-unused-vars': 'off',
    },
  },
];
