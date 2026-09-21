import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'out',
      'dist',
      'release',
      'coverage',
      '.demo-data',
      '.test-data',
      'test/fixtures',
      '.claude',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Control characters are handled on purpose (search highlight markers, NUL stripping).
      'no-control-regex': 'off',
      // Strings from Slack are untrusted; rendering goes through React nodes only (PLAN §3.6).
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Never render HTML from strings: build React nodes instead.',
        },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'scripts/**', 'test/**', '*.config.*'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
