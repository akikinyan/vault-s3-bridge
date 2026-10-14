import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'local',
		'dev-vault',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'scripts/*.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Local developer scripts and tests run in Node, not in Obsidian.
		files: ['scripts/**', 'tests/**'],
		rules: {
			'obsidianmd/rule-custom-message': 'off',
			'obsidianmd/prefer-window-timers': 'off',
			'@typescript-eslint/unbound-method': 'off',
			// Tests build DOM with plain browser APIs (happy-dom), not Obsidian's helpers.
			'obsidianmd/prefer-instanceof': 'off',
			'obsidianmd/no-global-this': 'off',
			'obsidianmd/prefer-create-el': 'off',
		},
	},
);
