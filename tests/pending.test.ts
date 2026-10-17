import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
	deviceIdOfFile,
	nodePendingIO,
	parsePendingFile,
	type PendingIO,
	type PendingItem,
	PendingStore,
	pendingFileName,
	type ReadOutcome,
} from '../src/upload/pending';
import { fileText, newItem, OTHER, OWN, storedItem } from './fixtures/pendingItems';

const OWN_FILE = pendingFileName(OWN);
const OTHER_FILE = pendingFileName(OTHER);

/** In-memory plugin folder. */
class FakeIO implements PendingIO {
	readonly files = new Map<string, string>();
	readonly log: string[] = [];
	failWrite = false;
	readonly readError = new Set<string>();
	inFlight = 0;
	maxInFlight = 0;
	beforeWrite?: (name: string) => void;

	read(name: string): Promise<ReadOutcome> {
		if (this.readError.has(name)) return Promise.resolve({ kind: 'error' });
		const text = this.files.get(name);
		return Promise.resolve(text === undefined ? { kind: 'missing' } : { kind: 'text', text });
	}
	async writeAtomic(name: string, text: string): Promise<void> {
		this.inFlight++;
		this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
		await new Promise((r) => setTimeout(r, 1));
		this.inFlight--;
		this.beforeWrite?.(name);
		if (this.failWrite) throw new Error('disk full');
		this.log.push(`write ${name}`);
		this.files.set(name, text);
	}
	rename(from: string, to: string): Promise<void> {
		const text = this.files.get(from);
		if (text === undefined) return Promise.reject(new Error('ENOENT'));
		this.files.delete(from);
		this.files.set(to, text);
		this.log.push(`rename ${from} ${to}`);
		return Promise.resolve();
	}
	unlink(name: string): Promise<void> {
		this.files.delete(name);
		this.log.push(`unlink ${name}`);
		return Promise.resolve();
	}
	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()]);
	}
	itemsOf(name: string): PendingItem[] {
		return (JSON.parse(this.files.get(name)!) as { items: PendingItem[] }).items;
	}
}

async function storeWith(io: PendingIO, deviceId = OWN): Promise<PendingStore> {
	const store = new PendingStore(io, deviceId, () => new Date('2026-10-17T01:02:03.004Z'));
	await store.load();
	return store;
}
const ids = (store: PendingStore) => store.items.map((i) => i.id);

describe('PendingStore — loading', () => {
	it('starts empty without writing when the file does not exist', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		expect(store.status).toBe('ready');
		expect(store.items).toEqual([]);
		expect(io.log).toEqual([]);
	});

	it.each([
		['empty file', ''],
		['not JSON', '{"version":1,'],
		['another version', JSON.stringify({ version: 2, deviceId: OWN, items: [] })],
		['another device id inside', fileText(OTHER, [])],
		['one item it does not understand', fileText(OWN, [storedItem('a'), { ...storedItem('b'), state: 'sending' }])],
		['an item with a missing field', fileText(OWN, [{ ...storedItem('a'), sentSha256: undefined }])],
		['duplicate ids', fileText(OWN, [storedItem('a'), storedItem('a')])],
	])('becomes damaged and never overwrites the file: %s', async (_, text) => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, text);
		const store = await storeWith(io);
		expect(store.status).toBe('damaged');
		expect(await store.add([newItem('x')])).toEqual({ ok: false, reason: 'not-ready' });
		expect(await store.takeOver(OTHER)).toEqual({ ok: false, reason: 'not-ready' });
		expect(io.files.get(OWN_FILE)).toBe(text);
		expect(io.log).toEqual([]);
	});

	it('becomes damaged when the file cannot be read', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('a')]));
		io.readError.add(OWN_FILE);
		expect((await storeWith(io)).status).toBe('damaged');
	});

	it('resets a damaged store only on request, setting the file aside under an ignored name', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, 'garbage');
		const store = await storeWith(io);
		expect(await store.resetDamaged()).toEqual({ ok: true });
		const aside = `pending-${OWN}.damaged-2026-10-17T01-02-03-004Z.json`;
		expect(io.files.get(aside)).toBe('garbage');
		expect(io.files.has(OWN_FILE)).toBe(false);
		expect(deviceIdOfFile(aside)).toBeUndefined(); // never read back as a record file
		expect(store.status).toBe('ready');
		expect(await store.add([newItem('a')])).toEqual({ ok: true });
		expect(await (await storeWith(new FakeIO())).resetDamaged()).toEqual({ ok: false, reason: 'not-ready' });
	});

	it('treats an item left in putting or indeterminate as uncertain and sent', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('p', { state: 'putting' }), storedItem('i', { state: 'indeterminate' }), storedItem('r')]));
		const store = await storeWith(io);
		expect(store.items.map((i) => [i.id, i.uncertain, i.putSent])).toEqual([['p', true, true], ['i', true, true], ['r', false, false]]);
		expect(await store.removeFailed(['p'])).toEqual({ ok: false, reason: 'not-removable' });
	});
});

describe('PendingStore — writing', () => {
	it('records a group in one write, or not at all', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		expect(await store.add([newItem('a'), newItem('b')])).toEqual({ ok: true });
		expect(io.log).toEqual([`write ${OWN_FILE}`]);
		expect(io.itemsOf(OWN_FILE).map((i) => [i.id, i.state, i.uncertain, i.putSent])).toEqual([['a', 'recorded', false, false], ['b', 'recorded', false, false]]);
		expect(await store.add([newItem('c'), newItem('a')])).toEqual({ ok: false, reason: 'duplicate-item' });
		io.failWrite = true;
		expect(await store.add([newItem('c'), newItem('d')])).toEqual({ ok: false, reason: 'write-failed' });
		expect(ids(store)).toEqual(['a', 'b']);
		expect(io.itemsOf(OWN_FILE).map((i) => i.id)).toEqual(['a', 'b']);
	});

	it('changes memory only after the file was written', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a')]);
		io.failWrite = true;
		expect(await store.update(['a'], { altKey: 'k/a-1.png', phase: 'alt' })).toEqual({ ok: false, reason: 'write-failed' });
		expect(store.items[0]).toMatchObject({ phase: 'prepared' });
		expect(store.items[0]?.altKey).toBeUndefined();
		io.failWrite = false;
		expect(await store.update(['a'], { altKey: 'k/a-1.png', phase: 'alt' })).toEqual({ ok: true });
		expect(io.itemsOf(OWN_FILE)[0]).toMatchObject({ altKey: 'k/a-1.png', phase: 'alt', updatedAt: '2026-10-17T01:02:03.004Z' });
		expect(await store.update(['zz'], { state: 'stopped' })).toEqual({ ok: false, reason: 'unknown-item' });
	});

	it('sets putSent itself and never clears putSent or uncertain', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a')]);
		await store.markPutting(['a']);
		expect(store.items[0]).toMatchObject({ state: 'putting', putSent: true, uncertain: false });
		await store.markIndeterminate(['a'], 'timeout');
		expect(store.items[0]).toMatchObject({ state: 'indeterminate', putSent: true, uncertain: true, reason: 'timeout' });
		// Even a caller that bypasses the types cannot clear the flags.
		await store.update(['a'], { state: 'stopped', uncertain: false, putSent: false } as never);
		expect(store.items[0]).toMatchObject({ state: 'stopped', putSent: true, uncertain: true });
		expect(io.itemsOf(OWN_FILE)[0]).toMatchObject({ putSent: true, uncertain: true });
	});

	it('runs every change through one queue, one write at a time', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await Promise.all([store.add([newItem('a')]), store.add([newItem('b')]), store.markPutting(['a']), store.update(['b'], { state: 'stopped' })]);
		expect(io.maxInFlight).toBe(1);
		expect(store.items.map((i) => [i.id, i.state])).toEqual([['a', 'putting'], ['b', 'stopped']]);
	});

	it('exposes frozen items', async () => {
		const store = await storeWith(new FakeIO());
		await store.add([newItem('a')]);
		expect(Object.isFrozen(store.items[0])).toBe(true);
	});
});

describe('PendingStore — removal rules (7-2)', () => {
	async function itemIn(state: PendingItem['state'], over: Partial<PendingItem> = {}) {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('a', { state, ...over })]));
		return { io, store: await storeWith(io) };
	}

	it('removes a failed item only when no Put of it can have created an object', async () => {
		expect(await (await itemIn('recorded')).store.removeFailed(['a'])).toEqual({ ok: true });
		// Earlier sessions sent Puts that all ended in a definite 4xx (e.g. 409 three times, then stopped).
		expect(await (await itemIn('stopped', { putSent: true })).store.removeFailed(['a'])).toEqual({ ok: true });
		for (const state of ['done-unrecorded', 'delivered', 'unresolved'] as const) {
			expect(await (await itemIn(state)).store.removeFailed(['a']), state).toEqual({ ok: false, reason: 'not-removable' });
		}
		expect(await (await itemIn('stopped', { uncertain: true, putSent: true })).store.removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
	});

	it('leaves putting without uncertainty only through a recorded rejection', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a'), newItem('b')]);
		await store.markPutting(['a', 'b']);
		expect(await store.removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' }); // still putting
		expect(await store.markPutRejected(['a'], 'conflict')).toEqual({ ok: true });
		expect(store.items[0]).toMatchObject({ state: 'recorded', putSent: true, uncertain: false, reason: 'conflict' });
		expect(await store.markPutRejected(['a'])).toEqual({ ok: false, reason: 'wrong-state' });
		// b stops without saying how its Put ended: that Put may have created the object.
		expect(await store.update(['b'], { state: 'stopped' })).toEqual({ ok: true });
		expect(store.items[1]).toMatchObject({ state: 'stopped', putSent: true, uncertain: true });
		expect(await store.removeFailed(['b'])).toEqual({ ok: false, reason: 'not-removable' });
		const again = await storeWith(io);
		expect(await again.removeFailed(['b'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(await again.removeFailed(['a'])).toEqual({ ok: true });
	});

	it('keeps an existing object protected after the item moves on (done-unrecorded, then stopped on resume)', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('a', { state: 'done-unrecorded', putSent: true })]));
		const store = await storeWith(io);
		expect(await store.update(['a'], { state: 'stopped', reason: 'aborted' })).toEqual({ ok: true });
		expect(io.itemsOf(OWN_FILE)[0]).toMatchObject({ state: 'stopped', uncertain: true });
		expect(await (await storeWith(io)).removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
	});

	it('protects an item that reused an existing object without any Put of its own', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a'), newItem('b')]);
		// a: Head matched (reused) and the state was saved, then a later pass stopped it.
		expect(await store.update(['a'], { state: 'done-unrecorded' })).toEqual({ ok: true });
		expect(await store.update(['a'], { state: 'stopped' })).toEqual({ ok: true });
		expect(await (await storeWith(io)).removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
		// b: the same, but saving done-unrecorded failed; memory still says recorded.
		io.failWrite = true;
		expect(await store.update(['b'], { state: 'done-unrecorded' })).toEqual({ ok: false, reason: 'write-failed' });
		io.failWrite = false;
		expect(store.items[1]).toMatchObject({ state: 'recorded' });
		expect(await store.removeFailed(['b'])).toEqual({ ok: false, reason: 'not-removable' });
	});

	it('persists an unknown outcome whose own write failed with the next write of the file', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a'), newItem('b')]);
		await store.markPutting(['a']);
		io.failWrite = true;
		expect(await store.markIndeterminate(['a'])).toEqual({ ok: false, reason: 'write-failed' });
		io.failWrite = false;
		// A later write of the same item, and a write of another item, both carry the fact to the disk.
		expect(await store.update(['b'], { state: 'stopped' })).toEqual({ ok: true });
		expect(io.itemsOf(OWN_FILE)[0]).toMatchObject({ id: 'a', uncertain: true });
		expect(await store.update(['a'], { state: 'stopped' })).toEqual({ ok: true });
		const again = await storeWith(io);
		expect(again.items[0]).toMatchObject({ id: 'a', state: 'stopped', uncertain: true });
		expect(await again.removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(await again.removeFailed(['b'])).toEqual({ ok: true });
	});

	it('remembers an unknown outcome in memory when writing it fails', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a'), newItem('b')]);
		await store.markPutting(['a', 'b']);
		io.failWrite = true;
		expect(await store.markIndeterminate(['a'])).toEqual({ ok: false, reason: 'write-failed' });
		expect(await store.update(['b'], { state: 'done-unrecorded' })).toEqual({ ok: false, reason: 'write-failed' });
		io.failWrite = false;
		expect(store.items.map((i) => [i.state, i.uncertain])).toEqual([['putting', false], ['putting', false]]); // memory follows the file
		expect(await store.removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(await store.removeFailed(['b'])).toEqual({ ok: false, reason: 'not-removable' });
		// The disk still says putting, which the next start reads as uncertain.
		expect((await storeWith(io)).items.every((i) => i.uncertain)).toBe(true);
	});

	it('removes completed items only when delivered, and discards anything on request', async () => {
		expect(await (await itemIn('done-unrecorded')).store.removeCompleted(['a'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(await (await itemIn('delivered', { uncertain: true, putSent: true })).store.removeCompleted(['a'])).toEqual({ ok: true });
		expect(await (await itemIn('unresolved', { uncertain: true })).store.removeDiscarded(['a'])).toEqual({ ok: true });
		expect(await (await itemIn('recorded')).store.removeDiscarded(['a', 'zz'])).toEqual({ ok: false, reason: 'unknown-item' });
	});

	it('removes nothing when one item of the request is not removable', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('a'), storedItem('b', { state: 'unresolved' })]));
		const store = await storeWith(io);
		expect(await store.removeFailed(['a', 'b'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(ids(store)).toEqual(['a', 'b']);
	});
});

describe('PendingStore — other devices (7-5)', () => {
	it('lists other record files only, marking damaged ones', async () => {
		const io = new FakeIO();
		const third = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('x'), storedItem('y')]));
		io.files.set(pendingFileName(third), 'broken');
		io.files.set(`${OTHER_FILE}.tmp-abc`, 'partial');
		io.files.set(`pending-${OTHER}.damaged-2026.json`, 'old');
		io.files.set('private-files.json', '{}');
		io.files.set(OWN_FILE, fileText(OWN, []));
		const store = await storeWith(io);
		expect(await store.others()).toEqual([{ deviceId: OTHER, count: 2 }, { deviceId: third, damaged: true }]);
	});

	it('merges, saves its own file first, then removes the other file', async () => {
		const io = new FakeIO();
		io.files.set(OWN_FILE, fileText(OWN, [storedItem('a', { state: 'stopped' })]));
		io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('a', { state: 'unresolved' }), storedItem('x', { state: 'putting' })]));
		const store = await storeWith(io);
		expect(await store.takeOver(OTHER)).toEqual({ ok: true });
		expect(io.log).toEqual([`write ${OWN_FILE}`, `unlink ${OTHER_FILE}`]);
		expect(store.items.map((i) => [i.id, i.state, i.uncertain])).toEqual([['a', 'stopped', false], ['x', 'putting', true]]);
		expect(await store.removeFailed(['x'])).toEqual({ ok: false, reason: 'not-removable' });
	});

	it('keeps items that reached the other file after it was read', async () => {
		const io = new FakeIO();
		io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('x')]));
		io.beforeWrite = (name) => {
			if (name === OWN_FILE) io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('x'), storedItem('late')]));
		};
		const store = await storeWith(io);
		expect(await store.takeOver(OTHER)).toEqual({ ok: true });
		expect(io.itemsOf(OTHER_FILE).map((i) => i.id)).toEqual(['late']);
		expect(ids(store)).toEqual(['x']);
	});

	it('leaves the other file untouched when its own save fails or the other file is damaged', async () => {
		const io = new FakeIO();
		const text = fileText(OTHER, [storedItem('x')]);
		io.files.set(OTHER_FILE, text);
		const store = await storeWith(io);
		io.failWrite = true;
		expect(await store.takeOver(OTHER)).toEqual({ ok: false, reason: 'write-failed' });
		expect(io.files.get(OTHER_FILE)).toBe(text);
		expect(ids(store)).toEqual([]);
		io.failWrite = false;
		io.files.set(OTHER_FILE, 'broken');
		expect(await store.takeOver(OTHER)).toEqual({ ok: false, reason: 'damaged-file' });
		expect(io.files.get(OTHER_FILE)).toBe('broken');
		expect(await store.takeOver(OWN)).toEqual({ ok: false, reason: 'not-found' });
		expect(await store.takeOver('../x')).toEqual({ ok: false, reason: 'not-found' });
	});
});

describe('PendingStore — files on disk', () => {
	const dirs: string[] = [];
	const tempDir = async () => {
		const d = await mkdtemp(join(tmpdir(), 'vsb-pending-'));
		dirs.push(d);
		return d;
	};
	afterEach(async () => {
		for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
	});

	it('distinguishes a missing file from one that cannot be read', async () => {
		const dir = await tempDir();
		const io = nodePendingIO(dir);
		expect(await io.read(OWN_FILE)).toEqual({ kind: 'missing' });
		await mkdir(join(dir, OWN_FILE)); // a directory cannot be read as a file
		expect(await io.read(OWN_FILE)).toEqual({ kind: 'error' });
		expect((await storeWith(io)).status).toBe('damaged');
	});

	it('writes atomically and reads back with a new store', async () => {
		const dir = await tempDir();
		const store = await storeWith(nodePendingIO(dir));
		await store.add([newItem('a')]);
		await store.markPutting(['a']);
		const again = await storeWith(nodePendingIO(dir));
		expect(again.status).toBe('ready');
		expect(again.items[0]).toMatchObject({ id: 'a', state: 'putting', uncertain: true, putSent: true });
		expect(await readdir(dir)).toEqual([OWN_FILE]);
		expect(parsePendingFile(await readFile(join(dir, OWN_FILE), 'utf8'), OWN)).toHaveLength(1);
	});

	it('keeps every file the store writes out of git', () => {
		const names = [OWN_FILE, `${OWN_FILE}.tmp-0a1b2c3d4e5f`, `pending-${OWN}.damaged-2026-10-17T01-02-03-004Z.json`];
		const out = execFileSync('git', ['check-ignore', '--no-index', ...names], { encoding: 'utf8' });
		expect(out.trim().split('\n')).toEqual(names);
	});

	describe('killed processes', () => {
		const child = fileURLToPath(new URL('./fixtures/pendingChild.ts', import.meta.url));
		const run = (dir: string, point: string, ...extra: string[]) => {
			const r = spawnSync(process.execPath, ['--import', 'tsx', child, dir, point, OWN, ...extra], { encoding: 'utf8', timeout: 30_000 });
			expect(r.signal, r.stderr).toBe('SIGKILL');
			expect(r.stdout).toBe(''); // killed before finishing
		};
		const reload = async (dir: string) => {
			const store = await storeWith(nodePendingIO(dir));
			expect(store.status).toBe('ready');
			return store;
		};

		it.each([
			['before-write', ['a']],
			['tmp-left', ['a']],
			['after-write', ['a', 'b']],
		])('%s: the file holds a complete earlier or later state', async (point, expected) => {
			const dir = await tempDir();
			run(dir, point);
			const store = await reload(dir);
			expect(ids(store)).toEqual(expected);
			expect(await store.others()).toEqual([]); // a leftover temporary file is not a record file
			expect(await store.add([newItem('c')])).toEqual({ ok: true });
		}, 30_000);

		it('takeover killed before the other file is cleaned up: no item is lost or duplicated', async () => {
			const dir = await tempDir();
			await writeFile(join(dir, OTHER_FILE), fileText(OTHER, [storedItem('x'), storedItem('y', { state: 'putting' })]));
			run(dir, 'takeover-before-cleanup', OTHER);
			const store = await reload(dir);
			expect(ids(store)).toEqual(['x', 'y']);
			expect(store.items[1]).toMatchObject({ uncertain: true });
			expect(await store.others()).toEqual([{ deviceId: OTHER, count: 2 }]);
			expect(await store.takeOver(OTHER)).toEqual({ ok: true });
			expect(ids(store)).toEqual(['x', 'y']);
			expect(await readdir(dir)).toEqual([OWN_FILE]);
		}, 30_000);
	});
});
