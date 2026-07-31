// Flat ESLint config (ESLint 10). Minimal, unopinionated: catch real bugs, stay
// out of style debates (formatting is left to the editor).
export default [
  {
    files: ['**/*.js', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-undef': 'off',
      eqeqeq: ['warn', 'smart'],
    },
  },
  { ignores: ['**/node_modules/**', '**/dist/**', '**/data/**'] },
];
