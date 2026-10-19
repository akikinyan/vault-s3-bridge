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
import { fileText, newItem, OTHER, OWN, storedItem, v1Item } from './fixtures/pendingItems';

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
		['a version that is not an integer', JSON.stringify({ version: 1.5, deviceId: OWN, items: [] })],
		['no version', JSON.stringify({ deviceId: OWN, items: [] })],
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

	it('changes keys only the way 6-0 and 7-2 allow', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('c', { key: 'old/c.png', phase: 'candidate' }), newItem('p'), newItem('s')]);
		// Candidate → prepared key, before any Put: allowed, and only to the recorded prepared key.
		expect(await store.update(['c'], { key: 'other/c.png', phase: 'prepared' })).toEqual({ ok: false, reason: 'wrong-state' });
		expect(await store.update(['c'], { key: 'k/c.png', phase: 'prepared' })).toEqual({ ok: true });
		expect(await store.update(['c'], { phase: 'candidate' })).toEqual({ ok: false, reason: 'wrong-state' }); // no going back
		// altKey is set once, together with the alt phase.
		expect(await store.update(['p'], { phase: 'alt' })).toEqual({ ok: false, reason: 'wrong-state' });
		expect(await store.update(['p'], { altKey: 'k/p-1.png' })).toEqual({ ok: false, reason: 'wrong-state' });
		expect(await store.update(['p'], { altKey: 'k/p-1.png', phase: 'alt' })).toEqual({ ok: true });
		expect(await store.update(['p'], { altKey: 'k/p-2.png', phase: 'alt' })).toEqual({ ok: false, reason: 'wrong-state' });
		// After a Put was sent, the key it went to must stay in the record.
		await store.markPutting(['s']);
		expect(await store.update(['s'], { key: 'k/elsewhere.png' })).toEqual({ ok: false, reason: 'wrong-state' });
		expect(store.items.map((i) => [i.key, i.altKey, i.phase])).toEqual([['k/c.png', undefined, 'prepared'], ['k/p.png', 'k/p-1.png', 'alt'], ['k/s.png', undefined, 'prepared']]);

		// A candidate record that already sent a Put (never produced by design; resumed as unresolved): its key stays.
		const disk = new FakeIO();
		disk.files.set(OWN_FILE, fileText(OWN, [storedItem('x', { key: 'old/x.png', phase: 'candidate', state: 'stopped', putSent: true })]));
		const loaded = await storeWith(disk);
		expect(await loaded.update(['x'], { key: 'k/x.png', phase: 'prepared' })).toEqual({ ok: false, reason: 'wrong-state' });
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

	it('leaves putting without uncertainty when the Put was never started', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a')]);
		await store.markPutting(['a']);
		// The checkpoint right before send() refused (e.g. the connection changed): nothing was sent.
		expect(await store.markPutNotStarted(['a'], 'connection-changed')).toEqual({ ok: true });
		expect(store.items[0]).toMatchObject({ state: 'stopped', reason: 'connection-changed', uncertain: false, putSent: true });
		expect(await store.markPutNotStarted(['a'], 'again')).toEqual({ ok: false, reason: 'wrong-state' });
		expect(await (await storeWith(io)).removeFailed(['a'])).toEqual({ ok: true });
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

	it('carries what memory knows about its own items into the file it writes on takeover', async () => {
		const io = new FakeIO();
		io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('x')]));
		const store = await storeWith(io);
		await store.add([newItem('a')]);
		// a reused an existing object, but saving done-unrecorded failed: only memory knows.
		io.failWrite = true;
		expect(await store.update(['a'], { state: 'done-unrecorded' })).toEqual({ ok: false, reason: 'write-failed' });
		io.failWrite = false;
		expect(await store.takeOver(OTHER)).toEqual({ ok: true });
		expect(io.itemsOf(OWN_FILE).find((i) => i.id === 'a')).toMatchObject({ uncertain: true });
		expect(await (await storeWith(io)).removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
	});

	it('keeps what memory knows across a second load in the same session', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.add([newItem('a'), newItem('b')]);
		io.failWrite = true;
		expect(await store.update(['a'], { state: 'done-unrecorded' })).toEqual({ ok: false, reason: 'write-failed' });
		io.failWrite = false;
		expect(await store.load()).toBe('ready');
		expect(await store.removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
		expect(await store.update(['b'], { state: 'stopped' })).toEqual({ ok: true });
		expect(await (await storeWith(io)).removeFailed(['a'])).toEqual({ ok: false, reason: 'not-removable' });
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

describe('PendingStore — discarding another device’s file (7-5)', () => {
	it('removes the file with unlink, also when it is damaged; never its own file', async () => {
		const io = new FakeIO();
		io.files.set(OTHER_FILE, fileText(OTHER, [storedItem('x')]));
		const store = await storeWith(io);
		expect(await store.discardOther(OTHER)).toEqual({ ok: true });
		expect(io.log).toEqual([`unlink ${OTHER_FILE}`]);
		expect(io.files.has(OTHER_FILE)).toBe(false);
		io.files.set(OTHER_FILE, 'broken');
		expect(await store.discardOther(OTHER)).toEqual({ ok: true });
		expect(io.files.has(OTHER_FILE)).toBe(false);
		// Already gone: nothing to do.
		expect(await store.discardOther(OTHER)).toEqual({ ok: true });
		expect(await store.discardOther(OWN)).toEqual({ ok: false, reason: 'not-found' });
		expect(await store.discardOther('../x')).toEqual({ ok: false, reason: 'not-found' });
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
		expect(parsePendingFile(await readFile(join(dir, OWN_FILE), 'utf8'), OWN)).toMatchObject({ version: 2, items: [{ id: 'a' }] });
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

describe('occurrences survive a restart (Markdown is copied from the record later)', () => {
	it('original, alt, size and the table flag are read back as written', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'vsb-pending-'));
		try {
			const occurrences = [
				{ original: '![[a.png\\|300]]', kind: 'embed' as const, alt: 'a', size: '300', inTable: true },
				{ original: '![図](a.png)', kind: 'embed' as const, alt: '図', inTable: false },
			];
			const first = new PendingStore(nodePendingIO(dir), OWN);
			expect(await first.load()).toBe('ready');
			expect((await first.add([newItem('a', { occurrences })])).ok).toBe(true);
			const restarted = new PendingStore(nodePendingIO(dir), OWN);
			expect(await restarted.load()).toBe('ready');
			expect(restarted.items[0]?.occurrences).toEqual(occurrences);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('record versions (design 1-2)', () => {
	it('migrates a version 1 file in memory and writes it as version 2 on the next change', async () => {
		const io = new FakeIO();
		const v1 = fileText(OWN, [v1Item('a', { state: 'delivered', uncertain: true, putSent: true })]);
		io.files.set(OWN_FILE, v1);
		const store = await storeWith(io);
		expect(store.status).toBe('ready');
		expect(store.items[0]).toMatchObject({ contentType: 'image/png', deliveryChecked: false, putSent: true, uncertain: true, state: 'delivered' });
		expect(store.items[0]?.occurrences[0]?.kind).toBe('embed');
		expect(io.files.get(OWN_FILE)).toBe(v1); // reading does not write
		expect((await store.add([newItem('b')])).ok).toBe(true);
		const written = JSON.parse(io.files.get(OWN_FILE)!) as { version: number; items: PendingItem[] };
		expect(written.version).toBe(2);
		expect(written.items.map((i) => [i.id, i.contentType, i.deliveryChecked])).toEqual([
			['a', 'image/png', false],
			['b', 'image/png', false],
		]);
	});

	it('rejects a version 1 item with a Phase 4 format, and a version 2 item without a Content-Type', async () => {
		for (const text of [
			fileText(OWN, [v1Item('a', { format: 'pdf' })]),
			fileText(OWN, [{ ...storedItem('a'), contentType: undefined }], 2),
			fileText(OWN, [{ ...storedItem('a'), contentType: 'text/plain\u0000' }], 2),
			fileText(OWN, [{ ...storedItem('a'), deliveryChecked: 'yes' }], 2),
			fileText(OWN, [{ ...storedItem('a'), occurrences: [{ original: '[[a.pdf]]', alt: 'a', inTable: false }] }], 2),
		]) {
			const io = new FakeIO();
			io.files.set(OWN_FILE, text);
			expect((await storeWith(io)).status).toBe('damaged');
		}
	});

	it('reads version 2 items with any attachment format and keeps link occurrences', async () => {
		const io = new FakeIO();
		const item = storedItem('a', {
			format: 'pdf',
			contentType: 'application/pdf',
			deliveryChecked: true,
			occurrences: [{ original: '[[a.pdf|資料]]', kind: 'link', alt: '資料', inTable: false }],
		});
		io.files.set(OWN_FILE, fileText(OWN, [item], 2));
		const store = await storeWith(io);
		expect(store.items[0]).toEqual(item);
	});

	it('keeps a file of a newer version unchanged and refuses every change, including a reset', async () => {
		const io = new FakeIO();
		const text = JSON.stringify({ version: 3, deviceId: OWN, items: [{ anything: true }], newField: 1 });
		io.files.set(OWN_FILE, text);
		const store = await storeWith(io);
		expect(store.status).toBe('future');
		expect(store.items).toEqual([]);
		expect(await store.add([newItem('x')])).toEqual({ ok: false, reason: 'not-ready' });
		expect(await store.resetDamaged()).toEqual({ ok: false, reason: 'not-ready' });
		expect(await store.takeOver(OTHER)).toEqual({ ok: false, reason: 'not-ready' });
		expect(io.files.get(OWN_FILE)).toBe(text);
		expect(io.log).toEqual([]);
	});

	it('neither takes over nor discards another device’s file of a newer version', async () => {
		const io = new FakeIO();
		const text = JSON.stringify({ version: 9, deviceId: OTHER, items: [] });
		io.files.set(OTHER_FILE, text);
		const store = await storeWith(io);
		expect(await store.others()).toEqual([{ deviceId: OTHER, future: true }]);
		expect(await store.takeOver(OTHER)).toEqual({ ok: false, reason: 'future-file' });
		expect(await store.discardOther(OTHER)).toEqual({ ok: false, reason: 'future-file' });
		expect(io.files.get(OTHER_FILE)).toBe(text);
	});

	it('rewrites another device’s version 1 file as version 1, so an older plugin there can still read it', async () => {
		const io = new FakeIO();
		io.files.set(OTHER_FILE, fileText(OTHER, [v1Item('a'), v1Item('b')]));
		const store = await storeWith(io);
		// The other device adds an item after we read its file: that item stays with it.
		io.beforeWrite = (name) => {
			if (name === OWN_FILE) io.files.set(OTHER_FILE, fileText(OTHER, [v1Item('a'), v1Item('b'), v1Item('c')]));
		};
		expect(await store.takeOver(OTHER)).toEqual({ ok: true });
		const rest = JSON.parse(io.files.get(OTHER_FILE)!) as { version: number; items: Record<string, unknown>[] };
		expect(rest.version).toBe(1);
		expect(rest.items).toEqual([v1Item('c')]);
		expect(JSON.parse(io.files.get(OWN_FILE)!)).toMatchObject({ version: 2 });
	});
});
