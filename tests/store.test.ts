import { describe, expect, it, vi } from 'vitest';
import { DEVICE_STORAGE_KEY } from '../src/settings/device';
import { addPrivateFilesOp, deleteConnectionOp, resetOp, saveConnectionOp, setFieldOp } from '../src/settings/ops';
import { SettingsStore, type StoreChange, type StoreIO } from '../src/settings/store';
import type { StorageConnection } from '../src/settings/types';

const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'x', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const pub: StorageConnection = { id: 'c2', alias: 'blog', provider: 'aws-s3', classification: 'public', bucket: 'p', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };

/** In-memory data.json and localStorage. `disk === undefined` means unreadable, `null` means missing. */
class FakeIO implements StoreIO {
	disk: unknown = null;
	readonly saves: Record<string, unknown>[] = [];
	failSave = false;
	loadImpl?: () => Promise<unknown>;
	sleeps = 0;
	readonly local = new Map<string, unknown>();
	readonly device: { load(key: string): unknown; save(key: string, data: unknown): void } = {
		load: (key: string) => this.local.get(key),
		save: (key: string, data: unknown) => void this.local.set(key, structuredClone(data)),
	};
	loadData(): Promise<unknown> {
		if (this.loadImpl) return this.loadImpl();
		return Promise.resolve(this.disk === undefined || this.disk === null ? this.disk : structuredClone(this.disk));
	}
	saveData(data: Record<string, unknown>): Promise<void> {
		if (this.failSave) return Promise.reject(new Error('disk full'));
		this.saves.push(structuredClone(data));
		this.disk = structuredClone(data);
		return Promise.resolve();
	}
	sleep(): Promise<void> {
		this.sleeps++;
		return Promise.resolve();
	}
}

async function storeWith(io: FakeIO): Promise<SettingsStore> {
	const store = new SettingsStore(io);
	await store.reload();
	return store;
}

describe('SettingsStore — reading', () => {
	it('migrates v1 on the first reload, writes it back and moves profiles to the device', async () => {
		const io = new FakeIO();
		io.disk = { schemaVersion: 1, connections: [{ ...priv, auth: { type: 'aws-sso-profile', profile: 'sso-a' } }] };
		const store = await storeWith(io);
		expect(store.current.schemaVersion).toBe(3);
		expect(store.current.privateBuckets).toEqual(['aws:x']);
		expect(store.device.profiles.c1?.profile).toBe('sso-a');
		expect(io.saves).toHaveLength(1);
		expect(JSON.stringify(io.saves[0])).not.toContain('sso-a');
	});

	it('keeps records this device already holds when the disk no longer has them', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		expect((await store.mutate(saveConnectionOp(undefined, priv, 'p'))).ok).toBe(true);
		// A sync replaces data.json with an older copy that never saw the private connection.
		io.disk = { schemaVersion: 2, connections: [] };
		await store.reload();
		expect(store.current.connections).toEqual([]);
		expect(store.current.privateBuckets).toEqual(['aws:x']);
		// The ledger still blocks publishing the bucket.
		const r = await store.mutate(saveConnectionOp(undefined, { ...pub, id: 'c9', alias: 'leak', bucket: 'x' }, 'p'));
		expect(r.ok).toBe(false);
	});

	it('follows the disk for ordinary settings and notifies only when something changed', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		const changes: StoreChange[] = [];
		store.subscribe((c) => changes.push(c));
		await store.reload();
		expect(changes).toHaveLength(0);
		io.disk = { ...(io.disk as object), language: 'ja' };
		await store.reload();
		expect(store.current.language).toBe('ja');
		expect(changes).toHaveLength(1);
		expect(store.generation).toBe(changes[0]!.generation);
	});

	it('freezes the settings it exposes, nested values included', async () => {
		const store = await storeWith(new FakeIO());
		const network = store.current.network as { proxyUrl?: string };
		expect(() => {
			network.proxyUrl = 'http://x';
		}).toThrow(TypeError);
		expect(() => (store.current.connections as StorageConnection[]).push(priv)).toThrow(TypeError);
	});

	it('freezes connections and the grow-only records too', async () => {
		const store = await storeWith(new FakeIO());
		expect((await store.mutate(saveConnectionOp(undefined, priv, 'p'))).ok).toBe(true);
		expect((await store.mutate(addPrivateFilesOp([HASH_A]))).ok).toBe(true);
		const c = store.current.connections[0] as { region: string };
		expect(() => {
			c.region = 'us-east-1';
		}).toThrow(TypeError);
		expect(() => (store.current.privateFiles as string[]).push(HASH_B)).toThrow(TypeError);
		expect(() => (store.current.privateBuckets as string[]).push('aws:z')).toThrow(TypeError);
	});
});

describe('SettingsStore — read-only data.json', () => {
	it('never saves over a newer schema, but still merges its records', async () => {
		const io = new FakeIO();
		io.disk = { schemaVersion: 99, connections: [priv], privateBuckets: ['aws:y'] };
		const store = await storeWith(io);
		expect(store.readOnly).toBe('future-version');
		expect(store.current.privateBuckets).toEqual(['aws:x', 'aws:y']);
		const r = await store.mutate(setFieldOp('language', 'ja'));
		expect(r).toMatchObject({ ok: false, reason: 'read-only', error: ['notice.readOnly'] });
		expect(io.saves).toHaveLength(0);
	});

	it('reads an unreadable data.json once more, then stays read-only without saving', async () => {
		const io = new FakeIO();
		io.disk = undefined;
		const store = await storeWith(io);
		expect(io.sleeps).toBe(1);
		expect(store.readOnly).toBe('unreadable');
		const r = await store.mutate(setFieldOp('language', 'ja'));
		expect(r).toMatchObject({ ok: false, reason: 'read-only', error: ['notice.unreadable'] });
		expect(io.saves).toHaveLength(0);
	});

	it('uses the second read when the first one hits a file being written', async () => {
		const io = new FakeIO();
		const reads = [undefined, { schemaVersion: 2, connections: [priv] }];
		io.loadImpl = () => Promise.resolve(reads.shift());
		const store = await storeWith(io);
		expect(store.readOnly).toBeUndefined();
		expect(store.current.connections.map((c) => c.id)).toEqual(['c1']);
	});

	it('clears the unreadable state by itself once the file can be read again', async () => {
		const io = new FakeIO();
		io.disk = undefined;
		const store = await storeWith(io);
		io.disk = { schemaVersion: 2, connections: [pub] };
		await store.reload();
		expect(store.readOnly).toBeUndefined();
		expect(store.current.connections.map((c) => c.id)).toEqual(['c2']);
	});

	it('resets and saves only while data.json is still unreadable, keeping the ledger', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, priv, 'p'));
		io.disk = undefined;
		await store.reload();
		expect(store.readOnly).toBe('unreadable');

		const r = await store.mutate(resetOp(), { allowUnreadable: true });
		expect(r.ok).toBe(true);
		expect(store.readOnly).toBeUndefined();
		expect(store.current.privateBuckets).toEqual(['aws:x']);
		expect((io.disk as { privateBuckets: string[] }).privateBuckets).toEqual(['aws:x']);
	});

	it('refuses to reset a data.json that became readable after the button was shown', async () => {
		const io = new FakeIO();
		io.disk = { schemaVersion: 2, connections: [priv] };
		const store = await storeWith(io);
		const before = io.saves.length;
		const r = await store.mutate(resetOp(), { allowUnreadable: true });
		expect(r).toMatchObject({ ok: false, reason: 'rejected' });
		expect(io.saves.length).toBe(before);
		expect(store.current.connections.map((c) => c.id)).toEqual(['c1']);
	});

	it('keeps the read-only state when saving the reset fails', async () => {
		const io = new FakeIO();
		io.disk = undefined;
		const store = await storeWith(io);
		io.failSave = true;
		const r = await store.mutate(resetOp(), { allowUnreadable: true });
		expect(r).toMatchObject({ ok: false, reason: 'save-failed' });
		expect(store.readOnly).toBe('unreadable');
	});

	it('a failed reset keeps the private records this device holds', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		expect((await store.mutate(addPrivateFilesOp([HASH_A]))).ok).toBe(true);
		io.disk = undefined;
		await store.reload();
		io.failSave = true;
		expect((await store.mutate(resetOp(), { allowUnreadable: true })).ok).toBe(false);
		expect(store.current.privateFiles).toEqual([HASH_A]);
		const restarted = await storeWith(io);
		expect(restarted.current.privateFiles).toEqual([HASH_A]);
	});

	it('a missing data.json (null) starts from the defaults and gets the records back from the device mirror', async () => {
		const io = new FakeIO();
		const first = await storeWith(io);
		expect((await first.mutate(addPrivateFilesOp([HASH_A]))).ok).toBe(true);
		io.disk = null;
		const restarted = await storeWith(io);
		expect(restarted.readOnly).toBeUndefined();
		expect(restarted.current.connections).toEqual([]);
		expect(restarted.current.privateFiles).toEqual([HASH_A]);
	});
});

describe('SettingsStore — mutate', () => {
	it('validates against the latest disk, not the state an editor opened with', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, pub, 'p'));
		// Another device deleted the connection meanwhile.
		io.disk = { ...(io.disk as object), connections: [] };
		const r = await store.mutate(saveConnectionOp(pub, { ...pub, region: 'us-east-1' }, 'p'));
		expect(r).toMatchObject({ ok: false, reason: 'rejected', error: ['error.connection-deleted'] });
		expect(store.current.connections).toEqual([]);
	});

	it('drops ordinary changes but keeps added records when saving fails', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		io.failSave = true;
		const r = await store.mutate(saveConnectionOp(undefined, priv, 'p'));
		expect(r).toMatchObject({ ok: false, reason: 'save-failed' });
		expect(store.current.connections).toEqual([]);
		expect(store.current.privateBuckets).toEqual(['aws:x']);
		expect(store.device.profiles.c1).toBeUndefined();
	});

	it('still succeeds when the device mirror cannot be saved', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		io.device.save = () => {
			throw new Error('QuotaExceededError');
		};
		const r = await store.mutate(saveConnectionOp(undefined, priv, 'p'));
		expect(r.ok).toBe(true);
		expect(store.current.connections.map((c) => c.id)).toEqual(['c1']);
		expect(store.mirrorFailed).toBe(true);
	});

	it('rejects an invalid value without saving', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		const before = io.saves.length;
		expect((await store.mutate(setFieldOp('proxyUrl', 'ftp://bad'))).ok).toBe(false);
		expect(io.saves.length).toBe(before);
	});

	it('treats an unchanged data.json as saved, so a profile-only change applies and is announced', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, priv, 'sso-a'));
		const before = io.saves.length;
		const changes: StoreChange[] = [];
		store.subscribe((c) => changes.push(c));

		const r = await store.mutate(saveConnectionOp(priv, priv, 'sso-b'));
		expect(r).toMatchObject({ ok: true, persisted: 'unchanged' });
		expect(io.saves.length).toBe(before);
		expect(store.device.profiles.c1).toEqual({ profile: 'sso-b', generation: 2 });
		expect(changes.map((c) => c.authChanged)).toEqual([['c1']]);
		expect((io.local.get(DEVICE_STORAGE_KEY) as { profiles: Record<string, { profile: string }> }).profiles.c1?.profile).toBe('sso-b');
	});

	it('removes the device profile together with the connection', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, priv, 'p'));
		await store.mutate(deleteConnectionOp('c1'));
		expect(store.current.connections).toEqual([]);
		expect(store.device.profiles.c1).toBeUndefined();
		expect(store.current.privateBuckets).toEqual(['aws:x']);
	});

	it('runs passes one at a time, so a slow read cannot overwrite a later change', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const stale = structuredClone(io.disk);
		io.loadImpl = async () => {
			await gate;
			return structuredClone(stale);
		};
		const reloading = store.reload();
		const saving = store.mutate(saveConnectionOp(undefined, priv, 'p'));
		io.loadImpl = undefined;
		release();
		await reloading;
		expect((await saving).ok).toBe(true);
		expect(store.current.connections.map((c) => c.id)).toEqual(['c1']);
		expect(store.current.privateBuckets).toEqual(['aws:x']);
	});

	it('a slow read that finishes after a private-file record is saved does not lose the record', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const stale = structuredClone(io.disk);
		io.loadImpl = async () => {
			await gate;
			return structuredClone(stale);
		};
		const reloading = store.reload();
		const saving = store.mutate(addPrivateFilesOp([HASH_A]));
		io.loadImpl = undefined;
		release();
		await reloading;
		expect((await saving).ok).toBe(true);
		await store.reload();
		expect(store.current.privateFiles).toEqual([HASH_A]);
		expect((io.disk as { privateFiles: string[] }).privateFiles).toEqual([HASH_A]);
	});

	it('private-file records added on two devices both survive, and one removed by a sync comes back', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		expect((await store.mutate(addPrivateFilesOp([HASH_A]))).ok).toBe(true);
		// The other device's data.json arrives through sync: it has its own record and not ours.
		io.disk = { ...(io.disk as object), privateFiles: [HASH_B] };
		await store.reload();
		expect(store.current.privateFiles).toEqual([HASH_A, HASH_B]);
		expect((io.disk as { privateFiles: string[] }).privateFiles).toEqual([HASH_A, HASH_B]);
	});
});

describe('SettingsStore — checkpoint', () => {
	it('checks against the disk even before the external-change notification arrives', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, pub, 'p'));
		const changes: StoreChange[] = [];
		store.subscribe((c) => changes.push(c));
		// Another device deleted the connection; onExternalSettingsChange has not run yet.
		io.disk = { ...(io.disk as object), connections: [] };
		const send = vi.fn();
		const started = await store.checkpoint((s) => {
			if (!s.connections.some((c) => c.id === 'c2')) return { started: false };
			send();
			return { started: true };
		});
		expect(started.started).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(store.current.connections).toEqual([]);
		expect(changes).toHaveLength(1);
	});

	it('also sees a changed region or classification on disk', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, pub, 'p'));
		io.disk = { ...(io.disk as object), connections: [{ ...pub, region: 'us-east-1' }] };
		const region = await store.checkpoint((s) => ({ region: s.connections[0]?.region }));
		expect(region.region).toBe('us-east-1');
	});

	it('does not wait for the response it started; later changes proceed meanwhile', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		await store.mutate(saveConnectionOp(undefined, pub, 'p'));
		let respond!: (v: string) => void;
		const response = new Promise<string>((r) => (respond = r));
		const handle = await store.checkpoint(() => ({ response }));
		// The queue is free while the request is still in flight.
		const deleted = await store.mutate(deleteConnectionOp('c2'));
		expect(deleted.ok).toBe(true);
		respond('done');
		expect(await handle.response).toBe('done');
	});

	it('never writes data.json', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		const before = io.saves.length;
		io.disk = { schemaVersion: 1, connections: [priv] };
		await store.checkpoint(() => 0);
		expect(io.saves.length).toBe(before);
	});
});

describe('SettingsStore — device id', () => {
	it('keeps one device id across passes, profile changes and an unreadable data.json', async () => {
		const io = new FakeIO();
		const store = await storeWith(io);
		const id = store.device.deviceId;
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect((io.local.get(DEVICE_STORAGE_KEY) as { deviceId: string }).deviceId).toBe(id);
		expect((await store.mutate(saveConnectionOp(undefined, priv, 'p'))).ok).toBe(true);
		expect(store.device.deviceId).toBe(id);
		expect((io.local.get(DEVICE_STORAGE_KEY) as { deviceId: string }).deviceId).toBe(id);

		// Read-only from the first load: the id is still saved and stays the same on the next start.
		const ro = new FakeIO();
		ro.disk = undefined;
		const first = await storeWith(ro);
		expect(first.readOnly).toBe('unreadable');
		const again = await storeWith(ro);
		expect(again.device.deviceId).toBe(first.device.deviceId);
	});
});
