import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyDeviceState } from '../src/settings/device';
import { mergeHistory, privateHashesOf, trimHistory } from '../src/settings/history';
import { loadSettings, serializeSettings } from '../src/settings/migrate';
import { addPrivateFilesOp, appendHistoryOp, saveConnectionOp } from '../src/settings/ops';
import { SettingsStore, type StoreIO } from '../src/settings/store';
import { DEFAULT_KEY_TEMPLATE, DEFAULT_UPLOAD, type HistoryEntry, type StorageConnection } from '../src/settings/types';
import { readJsonFile, writeFileAtomic } from '../src/util/atomicFile';

const h = (n: number) => n.toString(16).padStart(64, '0');

function entry(n: number, o: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: `e${String(n).padStart(5, '0')}`,
		target: 'aws:pub',
		key: `k/${n}.png`,
		classification: 'public',
		sourceSha256: h(n * 2),
		sentSha256: h(n * 2 + 1),
		size: 10,
		format: 'png',
		converter: 'c1;png;electron=1',
		at: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
		...o,
	};
}

const pubConn: StorageConnection = {
	id: 'c-pub',
	alias: 'blog',
	provider: 'aws-s3',
	classification: 'public',
	bucket: 'pub',
	region: 'ap-northeast-1',
	keyTemplate: DEFAULT_KEY_TEMPLATE.public,
};

class FakeIO implements StoreIO {
	disk: unknown = null;
	failSave = false;
	backup: unknown = undefined;
	backupWrites: string[][] = [];
	failBackup = false;
	readonly local = new Map<string, unknown>();
	readonly device = { load: (k: string) => this.local.get(k), save: (k: string, d: unknown) => this.local.set(k, structuredClone(d)) };
	readonly privateFilesBackup = {
		read: () => Promise.resolve(structuredClone(this.backup)),
		write: (hashes: readonly string[]) => {
			if (this.failBackup) return Promise.reject(new Error('EACCES'));
			this.backupWrites.push([...hashes]);
			this.backup = { version: 1, privateFiles: [...hashes] };
			return Promise.resolve();
		},
	};
	loadData(): Promise<unknown> {
		return Promise.resolve(this.disk === undefined || this.disk === null ? this.disk : structuredClone(this.disk));
	}
	saveData(data: Record<string, unknown>): Promise<void> {
		if (this.failSave) return Promise.reject(new Error('disk full'));
		this.disk = structuredClone(data);
		return Promise.resolve();
	}
	sleep(): Promise<void> {
		return Promise.resolve();
	}
}

async function storeWith(io: FakeIO): Promise<SettingsStore> {
	const store = new SettingsStore(io);
	await store.reload();
	return store;
}

describe('migration to schemaVersion 3', () => {
	const v1 = {
		schemaVersion: 1,
		connections: [
			{ id: 'a', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'x', region: 'r' },
			{ id: 'b', alias: 'blog', provider: 'aws-s3', classification: 'public', bucket: 'p', region: 'r' },
		],
	};

	it('v1 → v3 stores the default key template of each classification and adds empty records', () => {
		const { settings, changed } = loadSettings(v1, emptyDeviceState());
		expect(settings.schemaVersion).toBe(3);
		expect(settings.connections.map((c) => c.keyTemplate)).toEqual([DEFAULT_KEY_TEMPLATE.private, DEFAULT_KEY_TEMPLATE.public]);
		expect(settings).toMatchObject({ privateFiles: [], history: [], historyLimit: 2000, upload: DEFAULT_UPLOAD });
		expect(changed).toBe(true);
	});

	it('v2 → v3 keeps an existing template and unknown fields', () => {
		const v2 = { schemaVersion: 2, connections: [{ ...v1.connections[0], keyTemplate: 'mine/{hash}.{ext}' }], futureField: 1 };
		const { settings } = loadSettings(v2, emptyDeviceState());
		expect(settings.connections[0]?.keyTemplate).toBe('mine/{hash}.{ext}');
		expect(serializeSettings(settings).futureField).toBe(1);
	});

	it('drops malformed hashes and history entries, and resets out-of-range upload values', () => {
		const { settings } = loadSettings(
			{
				schemaVersion: 3,
				privateFiles: [h(1), 'ABC', h(1).toUpperCase(), 7],
				history: [entry(1), { ...entry(2), sentSha256: 'x' }, { ...entry(3), format: 'svg' }, 'junk'],
				historyLimit: 5,
				upload: { webp: { enabled: true, quality: 3 }, maxFileMB: 0, maxJobMB: 50, excludeFolders: ['/a/b/', 'a/b', '', 1] },
			},
			emptyDeviceState(),
		);
		expect(settings.privateFiles).toEqual([h(1)]);
		expect(settings.history.map((e) => e.id)).toEqual(['e00001']);
		expect(settings.historyLimit).toBe(2000);
		expect(settings.upload).toMatchObject({ webp: { enabled: true, quality: 0.85 }, maxFileMB: 20, maxJobMB: 50, excludeFolders: ['a/b'] });
	});
});

describe('history rules', () => {
	it('merges by id and trims to the same result whatever the order', () => {
		const a = [entry(1), entry(3), entry(5)];
		const b = [entry(2), entry(3), entry(4)];
		const ab = trimHistory(mergeHistory(a, b), 3).map((e) => e.id);
		const ba = trimHistory(mergeHistory(b, a), 3).map((e) => e.id);
		expect(ab).toEqual(['e00005', 'e00004', 'e00003']);
		expect(ba).toEqual(ab);
		// Merging an already trimmed copy with an old one converges to the same list.
		expect(trimHistory(mergeHistory(ab.map((id) => [...a, ...b].find((e) => e.id === id)), a), 3).map((e) => e.id)).toEqual(ab);
	});

	it('collects hashes of private entries and of entries whose target became private', () => {
		const list = [entry(1, { classification: 'private', target: 'aws:x' }), entry(2), entry(3, { target: 'aws:other' })];
		expect(privateHashesOf(list, ['aws:pub']).sort()).toEqual([h(2), h(3), h(4), h(5)].sort());
		expect(privateHashesOf(list, []).sort()).toEqual([h(2), h(3)]);
	});
});

describe('SettingsStore — schemaVersion 3 records', () => {
	it('imports the hashes of a reclassified connection before trimming the history in the same save (C1)', async () => {
		const io = new FakeIO();
		const old = Array.from({ length: 5 }, (_, i) => entry(i + 1)); // to aws:pub, the oldest entries
		const kept = Array.from({ length: 95 }, (_, i) => entry(1000 + i, { target: 'aws:elsewhere' }));
		io.disk = { schemaVersion: 3, connections: [pubConn], history: [...old, ...kept], historyLimit: 100 };
		const store = await storeWith(io);
		expect(store.current.history).toHaveLength(100);
		expect(store.current.privateFiles).toEqual([]);

		// Another device's newer uploads arrive by synchronisation just before the save,
		// so the very save that makes the connection private also trims the old entries away.
		const arrived = Array.from({ length: 5 }, (_, i) => entry(5000 + i, { target: 'aws:elsewhere' }));
		io.disk = { ...(io.disk as object), history: [...old, ...kept, ...arrived] };
		const r = await store.mutate(saveConnectionOp(pubConn, { ...pubConn, classification: 'private' }, 'p'));
		expect(r.ok).toBe(true);
		for (const e of old) {
			expect(store.current.privateFiles).toContain(e.sourceSha256);
			expect(store.current.privateFiles).toContain(e.sentSha256);
		}
		expect(store.current.history.some((e) => old.some((o) => o.id === e.id))).toBe(false);
		expect((io.disk as { privateFiles: string[] }).privateFiles).toHaveLength(10);
	});

	it('imports the hashes when only the ledger arrives by synchronisation', async () => {
		const io = new FakeIO();
		io.disk = { schemaVersion: 3, connections: [pubConn], history: [entry(1)] };
		const store = await storeWith(io);
		io.disk = { ...(io.disk as object), privateBuckets: ['aws:pub'] };
		await store.reload();
		expect(store.current.privateFiles).toEqual([h(2), h(3)]);
	});

	it('merges private-files.json and rewrites it only when its content changes', async () => {
		const io = new FakeIO();
		io.backup = { version: 1, privateFiles: [h(9)] };
		const store = await storeWith(io);
		expect(store.current.privateFiles).toEqual([h(9)]);
		expect((await store.mutate(addPrivateFilesOp([h(7)]))).ok).toBe(true);
		expect(io.backupWrites).toEqual([[h(7), h(9)]]);
		expect((await store.mutate(addPrivateFilesOp([h(7)]))).ok).toBe(true);
		expect(io.backupWrites).toHaveLength(1);
	});

	it('ignores a damaged private-files.json without stopping', async () => {
		const io = new FakeIO();
		io.backup = 'not an object';
		const store = await storeWith(io);
		expect(store.current.privateFiles).toEqual([]);
		expect((await store.mutate(addPrivateFilesOp([h(1)]))).ok).toBe(true);
	});

	it('treats a failed private-files.json write as a warning: data.json keeps the record', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		io.failBackup = true;
		const r = await store.mutate(addPrivateFilesOp([h(1)]));
		expect(r.ok).toBe(true);
		expect(store.backupFailed).toBe(true);
		expect((io.disk as { privateFiles: string[] }).privateFiles).toEqual([h(1)]);
	});

	it('does not write private-files.json while read-only', async () => {
		const io = new FakeIO();
		io.disk = { schemaVersion: 99 };
		io.backup = { version: 1, privateFiles: [h(1)] };
		const store = await storeWith(io);
		await store.mutate(addPrivateFilesOp([h(2)]));
		expect(io.backupWrites).toEqual([]);
		expect(store.current.privateFiles).toEqual([h(1)]);
	});

	it('keeps added hashes in memory when data.json cannot be saved, but reports the failure (I1)', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		io.failSave = true;
		const r = await store.mutate(addPrivateFilesOp([h(1)]));
		expect(r).toMatchObject({ ok: false, reason: 'save-failed' });
		expect(store.current.privateFiles).toEqual([h(1)]);
		expect(io.backupWrites).toEqual([]);
	});

	it('reports an already recorded hash as persisted (unchanged)', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(addPrivateFilesOp([h(1)]));
		expect(await store.mutate(addPrivateFilesOp([h(1)]))).toMatchObject({ ok: true, persisted: 'unchanged' });
	});

	it('rejects malformed hashes and history entries as a whole', async () => {
		const store = await storeWith(new FakeIO());
		expect((await store.mutate(addPrivateFilesOp([h(1), 'bad']))).ok).toBe(false);
		expect((await store.mutate(appendHistoryOp([entry(1), { ...entry(2), size: -1 }]))).ok).toBe(false);
		expect(store.current.privateFiles).toEqual([]);
		expect((await store.mutate(appendHistoryOp([entry(1)]))).ok).toBe(true);
		expect(store.current.history.map((e) => e.id)).toEqual(['e00001']);
	});
});

describe('writeFileAtomic', () => {
	it('replaces the file and leaves no temporary file behind', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'vsb-atomic-'));
		const path = join(dir, 'f.json');
		await writeFileAtomic(path, '{"a":1}');
		await writeFileAtomic(path, '{"a":2}');
		expect(await readJsonFile(path)).toEqual({ a: 2 });
		expect(readdirSync(dir)).toEqual(['f.json']);
	});

	it('reads a missing or damaged file as undefined', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'vsb-atomic-'));
		expect(await readJsonFile(join(dir, 'none.json'))).toBeUndefined();
		writeFileSync(join(dir, 'bad.json'), '{"a":');
		expect(await readJsonFile(join(dir, 'bad.json'))).toBeUndefined();
	});

	it('keeps the previous file when the target directory is gone', async () => {
		await expect(writeFileAtomic(join(tmpdir(), 'vsb-no-such-dir', 'f.json'), '{}')).rejects.toThrow();
	});
});
