import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
	eslint.configs.recommended,
	tseslint.configs.strict,
	tseslint.configs.stylistic,
	eslintConfigPrettier,
	eslintPluginPrettierRecommended,
);
