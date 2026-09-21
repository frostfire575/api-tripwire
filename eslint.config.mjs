import tseslint from 'typescript-eslint';
import spacing from './scripts/eslint-spacing.mjs';

export default tseslint.config(
  { ignores: ['dist/**', 'fixtures/**', 'examples/**'] },
  ...tseslint.configs.recommended,
  {
    plugins: { local: spacing },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'local/declaration-spacing': 'error',
    },
  },
);
