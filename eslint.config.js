import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Cardo lint rules. Two rules are non-negotiable architecture guards:
// 1. no hardcoded colors anywhere in UI/tool code (design tokens only)
// 2. tools may only import from @cardo/plugin-api and @cardo/ui

const noHardcodedColors = {
  selector:
    "Literal[value=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/], TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}\\b|rgba?\\(|hsla?\\(/]",
  message:
    'Hardcoded color detected. Use semantic design tokens (var(--…)) from @cardo/ui instead.',
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/target/**', '**/*.gen.ts', '**/.astro/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-syntax': ['error', noHardcodedColors],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Tools are sandboxed at compile time: plugin API + shared UI kit only.
    files: ['packages/tools/*/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cardo/core', '@cardo/core/*', '@tauri-apps/*', '**/apps/desktop/**'],
              message:
                'Tools must only use @cardo/plugin-api and @cardo/ui. Direct access to the host or Tauri is forbidden.',
            },
          ],
        },
      ],
    },
  },
  {
    // Theme JSONs are the ONLY place colors may live (tokens.css is
    // covered by stylelint + token-lint.sh, not ESLint).
    files: ['packages/themes/**/*.{js,ts}'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Build scripts and config files run under Node, not the browser.
    files: ['scripts/**/*.mjs', '**/*.config.{js,cjs,mjs}', '**/astro.config.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        module: 'writable',
        require: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
  },
);
