import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/naming-convention': [
        'error',
        // types / interfaces / classes / enums — PascalCase, no I/T prefix
        // (regex requires lowercase 3rd char so acronym names like TRC20Transfer stay legal)
        {
          selector: 'typeLike',
          format: ['PascalCase'],
          custom: { regex: '^(I|T)[A-Z][a-z]', match: false },
        },
        // generic type parameters — single letter T/K/V or PascalCase
        {
          selector: 'typeParameter',
          format: ['PascalCase'],
        },
        // enum members — UPPER_CASE
        {
          selector: 'enumMember',
          format: ['UPPER_CASE'],
        },
        // destructured variables — unconstrained (snake_case API bodies are
        // destructured directly after Zod validation)
        {
          selector: 'variable',
          modifiers: ['destructured'],
          format: null,
        },
        // variables — camelCase or UPPER_CASE (top-level constants);
        // allowSingleOrDouble covers the ESM __dirname shim
        {
          selector: 'variable',
          format: ['camelCase', 'UPPER_CASE', 'PascalCase'],
          leadingUnderscore: 'allowSingleOrDouble',
        },
        // functions — camelCase (verb-led) or PascalCase (factories returning classes)
        {
          selector: 'function',
          format: ['camelCase', 'PascalCase'],
        },
        // parameters — camelCase, leading _ allowed for unused
        {
          selector: 'parameter',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // class members — camelCase
        {
          selector: 'memberLike',
          format: ['camelCase'],
          leadingUnderscore: 'allow',
        },
        // type properties — unconstrained, same interop rationale as object
        // literals (TronGrid JSON shapes, Fastify route generics like
        // { Params }, snake_case webhook payload types)
        {
          selector: 'typeProperty',
          format: null,
        },
        // object literal properties — unconstrained
        // (Drizzle returns camelCase, API JSON uses snake_case, DB columns are snake_case,
        // Redis keys use colon:notation — single format would break interop)
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
        // import names — passthrough whatever the imported library uses
        {
          selector: 'import',
          format: null,
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'dashboard/', 'checkout/', 'drizzle.config.ts'],
  }
);
