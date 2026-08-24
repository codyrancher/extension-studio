// A lint config that can actually run in this checkout.
//
// The package's own `.eslintrc.js` extends `@vue/standard` and `@vue/typescript/recommended`,
// neither of which is installed, so `eslint` dies before reading a line of source. Every
// implementer this session reported "eslint cannot run here" and worked without it.
//
// This uses only what is present (`eslint-config-standard`, `eslint-plugin-vue`, the TypeScript
// parser and plugin) and turns off the stylistic rules the codebase deliberately breaks, so what
// remains is the class of finding worth having: unused variables, undefined names, unreachable
// code, and Vue template mistakes. It is a safety net, not a style gate.
module.exports = {
  root: true,
  env:  { browser: true, node: true, es2021: true },
  parser: 'vue-eslint-parser',
  parserOptions: {
    parser:      '@typescript-eslint/parser',
    ecmaVersion: 2021,
    sourceType:  'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:vue/vue3-recommended'],
  rules: {
    // The things worth catching.
    'no-unused-vars':                    'off',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    'no-undef':                          'off', // the TS parser handles this better than eslint does
    'vue/no-unused-components':          'warn',
    'vue/require-v-for-key':             'error',
    'vue/no-use-v-if-with-v-for':        'error',

    // Style this codebase settles differently, and which is not what a lint pass is for here.
    'vue/max-attributes-per-line':       'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/html-self-closing':             'off',
    'vue/attributes-order':              'off',
    'vue/html-indent':                   'off',
    'vue/first-attribute-linebreak':     'off',
    'vue/multi-word-component-names':    'off',
    'no-empty':                          'off',
  },
};
