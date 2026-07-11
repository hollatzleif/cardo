/**
 * Colors may only be defined in packages/ui/src/tokens.css (semantic layer)
 * and packages/themes/*.json (primitive palettes). Everywhere else: var(--…).
 */
module.exports = {
  ignoreFiles: ['**/dist/**', '**/node_modules/**', '**/target/**'],
  rules: {
    'color-no-hex': true,
    'function-disallowed-list': ['rgb', 'rgba', 'hsl', 'hsla', 'color'],
    'declaration-property-value-disallowed-list': {
      '/^(background|border|color|fill|stroke|outline|box-shadow)/': [
        '/#[0-9a-fA-F]{3,8}/',
        '/rgba?\\(/',
        '/hsla?\\(/',
      ],
    },
  },
  overrides: [
    {
      files: ['packages/ui/src/tokens.css'],
      rules: {
        'color-no-hex': null,
        'function-disallowed-list': null,
        'declaration-property-value-disallowed-list': null,
      },
    },
  ],
};
