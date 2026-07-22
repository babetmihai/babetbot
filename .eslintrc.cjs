module.exports = {
  root: true,
  env: { es2020: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  rules: {
    "@typescript-eslint/ban-ts-comment": "off",
    "semi": ["warn", "never"],
    "no-multi-spaces": "warn",
    "padded-blocks": 0,
    "comma-dangle":  ["warn", "never"],
    "object-curly-spacing": [
      "warn",
      "always"
    ],
    "brace-style": "warn",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": ["warn"],
    "@typescript-eslint/no-explicit-any": "off",
    "max-len": [
      "warn",
      160,
      4,
      {
        "ignoreComments": true
      }
    ],
    "space-infix-ops": "warn",
    "no-trailing-spaces": "warn",
    "indent": [
      "warn",
      2,
      {
        "SwitchCase": 1
      }
    ],
    "linebreak-style": [
      "warn",
      "unix"
    ],
    "quotes": [
      "warn",
      "double"
    ],
    "no-extra-semi": "off",
    "no-extra-boolean-cast": "warn",
    "no-console": "warn",
    "key-spacing": [
      "warn",
      {
        "beforeColon": false,
        "afterColon": true
      }
    ],
    "comma-spacing": [
      "warn",
      {
        "before": false,
        "after": true
      }
    ],
    "semi-spacing": [
      "warn",
      {
        "before": false,
        "after": true
      }
    ],
    "space-before-function-paren": [
      "warn",
      {
        "asyncArrow": "always",
        "named": "never",
        "anonymous": "never"
      }
    ],
    "space-before-blocks": [
      "warn"
    ],
    "no-multiple-empty-lines": [
      "warn",
      {
        "max": 2,
        "maxEOF": 1,
        "maxBOF": 1
      }
    ],
    "spaced-comment": [
      "warn",
      "always"
    ],
  
    "space-in-parens": [
      "warn",
      "never"
    ],
    "arrow-spacing": [
      "warn"
    ]
  }
}