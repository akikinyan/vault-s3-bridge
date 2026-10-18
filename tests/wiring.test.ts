// 2-2: every write of data.json goes through the SettingsStore. Only the store's own IO may call saveData.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = new URL('../src/', import.meta.url).pathname;

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
}

describe('settings write path (2-2)', () => {
	it('saveData is called only to hand it to the SettingsStore', () => {
		const calls = sources(SRC).flatMap((path) =>
			readFileSync(path, 'utf8')
				.split('\n')
				.filter((line) => line.includes('saveData('))
				.map((line) => `${path.slice(SRC.length)}: ${line.trim()}`),
		);
		expect(calls.sort()).toEqual([
			'main.ts: saveData: (data) => this.saveData(data),',
			'settings/store.ts: await this.io.saveData(out);',
			'settings/store.ts: await this.io.saveData(serializeSettings(next));',
			'settings/store.ts: saveData(data: Record<string, unknown>): Promise<void>;',
		]);
	});
});
