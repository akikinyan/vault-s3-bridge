// 7-3: the upload process is killed at each point, then a new process resumes from what is on disk.
// Records, settings and the bucket are real files, so object counts are compared across the restart.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { nodePendingIO, PendingStore } from '../src/upload/pending';
import { OWN } from './fixtures/pendingItems';

const child = fileURLToPath(new URL('./fixtures/uploadChild.ts', import.meta.url));
const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const spawn = (dir: string, ...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', child, dir, ...args], { encoding: 'utf8', timeout: 30_000 });

async function states(dir: string): Promise<string[]> {
	const store = new PendingStore(nodePendingIO(dir), OWN);
	expect(await store.load()).toBe('ready');
	return store.items.map((i) => i.state);
}

interface Resumed {
	resumed: string[][];
	results: { id: string; outcome: string }[];
	items: { id: string; state: string; uncertain: boolean; occurrences: number; altKey?: string }[];
	objects: string[];
	history: { key: string }[];
	privateFiles: string[];
}

describe('killed during an upload, resumed by a new process (7-3)', () => {
	it.each([
		// point, state left on disk, whether the resume sends again
		['after-record', 'recorded', true],
		['put-lost', 'putting', true],
		['put-arrived', 'putting', true],
		['before-history', 'done-unrecorded', true],
		['before-apply', 'delivered', false],
	] as const)('%s', async (point, left, resumes) => {
		for (const count of ['one', 'two'] as const) {
			const dir = await mkdtemp(join(tmpdir(), 'vsb-upload-'));
			dirs.push(dir);
			const killed = spawn(dir, 'send', point, count);
			expect(killed.signal, killed.stderr).toBe('SIGKILL');
			expect(killed.stdout).toBe('');
			const n = count === 'two' ? 2 : 1;
			expect(await states(dir)).toEqual(Array<string>(n).fill(left));

			const r = spawn(dir, 'resume');
			expect(r.status, r.stderr).toBe(0);
			const out = JSON.parse(r.stdout) as Resumed;
			// One object at the group's key, whatever the point; never an alternate key.
			expect(out.objects).toEqual(['k/a.png']);
			// Delivered items are never resumed; everything else ends delivered, waiting for the Markdown copy.
			expect(out.resumed).toEqual(resumes ? [count === 'two' ? ['a', 'b'] : ['a']] : []);
			expect(out.items.map((i) => [i.id, i.state, i.occurrences])).toEqual(
				(count === 'two' ? ['a', 'b'] : ['a']).map((id) => [id, 'delivered', 1]),
			);
			// One history entry per source file, all at the same key (6-0); I1 recorded before anything was sent.
			expect(out.history.map((h) => h.key)).toEqual(Array<string>(n).fill('k/a.png'));
			expect(out.privateFiles).toContain('c'.repeat(64));
			if (count === 'two') expect(out.privateFiles).toContain('d'.repeat(64));
		}
	}, 60_000);
});

describe('killed after the group moved to the alternate key, resumed by a new process (6-0, 7-3)', () => {
	it.each(['after-alt', 'put-lost', 'put-arrived', 'before-history'] as const)('%s', async (point) => {
		const dir = await mkdtemp(join(tmpdir(), 'vsb-upload-'));
		dirs.push(dir);
		const killed = spawn(dir, 'send', point, 'alt');
		expect(killed.signal, killed.stderr).toBe('SIGKILL');
		const r = spawn(dir, 'resume');
		expect(r.status, r.stderr).toBe(0);
		const out = JSON.parse(r.stdout) as Resumed;
		const alt = out.items[0]?.altKey;
		expect(alt).toMatch(/^k\/a-[0-9a-f]{8}\.png$/);
		// The other content stays where it was; ours is at the alternate key only, once.
		expect(out.objects.sort()).toEqual(['k/a.png', alt!].sort());
		expect(out.items.map((i) => [i.state, i.altKey])).toEqual([['delivered', alt]]);
		expect(out.history.map((h) => h.key)).toEqual([alt]);
	}, 60_000);
});
