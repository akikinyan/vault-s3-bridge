import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(new URL('./tests/mocks/obsidian.ts', import.meta.url)),
			// Same substitution as the production bundle (esbuild.config.mjs).
			'@aws-sdk/credential-provider-node': fileURLToPath(new URL('./src/aws/noDefaultCredentials.ts', import.meta.url)),
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		environment: 'node',
	},
});
