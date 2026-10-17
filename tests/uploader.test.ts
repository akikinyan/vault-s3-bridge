import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { saveConnectionOp } from '../src/settings/ops';
import { SettingsStore, type StoreIO } from '../src/settings/store';
import type { StorageConnection } from '../src/settings/types';
import { type NewPendingItem, type PendingIO, PendingStore, pendingFileName, type ReadOutcome } from '../src/upload/pending';
import { checksumOf } from '../src/upload/s3';
import { resumeGroup, sendGroup, type UploaderDeps } from '../src/upload/uploader';
import { OWN } from './fixtures/pendingItems';

const BODY = new TextEncoder().encode('example image bytes');
const SENT = createHash('sha256').update(BODY).digest('hex');
const OTHER_BODY = new TextEncoder().encode('different bytes');
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'c'.repeat(64);

const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };
const pub: StorageConnection = { id: 'c2', alias: 'blog', provider: 'aws-s3', classification: 'public', bucket: 'example-public', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };

/** One event log shared by every fake, to check the order of writes and requests. */
type Log = string[];

class MemoryStoreIO implements StoreIO {
	disk: unknown = null;
	failSave = false;
	readonly local = new Map<string, unknown>();
	constructor(private readonly log: Log) {}
	readonly device = { load: (k: string) => this.local.get(k), save: (k: string, v: unknown) => void this.local.set(k, structuredClone(v)) };
	loadData(): Promise<unknown> {
		return Promise.resolve(this.disk === null ? null : structuredClone(this.disk));
	}
	saveData(data: Record<string, unknown>): Promise<void> {
		if (this.failSave) return Promise.reject(new Error('disk full'));
		this.log.push('settings:save');
		this.disk = structuredClone(data);
		return Promise.resolve();
	}
	sleep(): Promise<void> {
		return Promise.resolve();
	}
}

class MemoryPendingIO implements PendingIO {
	readonly files = new Map<string, string>();
	writes = 0;
	/** After this many writes the "process" is gone: later writes fail. */
	crashAfter = Infinity;
	onCrash?: () => void;
	constructor(private readonly log: Log) {}
	read(name: string): Promise<ReadOutcome> {
		const text = this.files.get(name);
		return Promise.resolve(text === undefined ? { kind: 'missing' } : { kind: 'text', text });
	}
	writeAtomic(name: string, text: string): Promise<void> {
		if (this.writes >= this.crashAfter) return Promise.reject(new Error('process ended'));
		this.writes++;
		const states = (JSON.parse(text) as { items: { state: string }[] }).items.map((i) => i.state).join(',');
		this.log.push(`pending:${states}`);
		this.files.set(name, text);
		if (this.writes === this.crashAfter) this.onCrash?.();
		return Promise.resolve();
	}
	rename(): Promise<void> {
		return Promise.resolve();
	}
	unlink(name: string): Promise<void> {
		this.files.delete(name);
		return Promise.resolve();
	}
	list(): Promise<string[]> {
		return Promise.resolve([...this.files.keys()]);
	}
}

const sdkError = (status: number, name: string) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

type Answer = (key: string, signal: AbortSignal | undefined) => unknown;

/** In-memory bucket: Head returns the stored checksum, Put never overwrites. Scripted answers come first. */
class FakeS3 {
	readonly objects = new Map<string, string>();
	readonly calls: { op: 'head' | 'put'; key: string; timeout?: number }[] = [];
	readonly script: { op: 'head' | 'put'; answer: Answer }[] = [];
	constructor(private readonly log: Log) {}
	send(command: { constructor: { name: string }; input: Record<string, unknown> }, options?: { abortSignal?: AbortSignal; requestTimeout?: number }) {
		const op = command.constructor.name === 'HeadObjectCommand' ? 'head' : 'put';
		const key = command.input.Key as string;
		this.calls.push({ op, key, timeout: options?.requestTimeout });
		this.log.push(`s3:${op}:${key}`);
		const i = this.script.findIndex((s) => s.op === op);
		if (i >= 0) {
			const [s] = this.script.splice(i, 1);
			return Promise.resolve().then(() => s!.answer(key, options?.abortSignal));
		}
		if (op === 'head') {
			const sum = this.objects.get(key);
			return sum === undefined ? Promise.reject(sdkError(404, 'NotFound')) : Promise.resolve({ ChecksumSHA256: sum, ChecksumType: 'FULL_OBJECT' });
		}
		if (this.objects.has(key)) return Promise.reject(sdkError(412, 'PreconditionFailed'));
		this.objects.set(key, command.input.ChecksumSHA256 as string);
		return Promise.resolve({});
	}
	on(op: 'head' | 'put', answer: Answer): this {
		this.script.push({ op, answer });
		return this;
	}
	ops(): string[] {
		return this.calls.map((c) => `${c.op}:${c.key}`);
	}
}

interface Setup {
	log: Log;
	storeIO: MemoryStoreIO;
	settings: SettingsStore;
	pendingIO: MemoryPendingIO;
	pending: PendingStore;
	s3: FakeS3;
	abort: AbortController;
	deps: UploaderDeps;
	sleeps: number[];
	changed: Set<string>;
	refuse: { reason?: string; after?: number };
}

async function setup(connections: StorageConnection[] = [priv, pub]): Promise<Setup> {
	const log: Log = [];
	const storeIO = new MemoryStoreIO(log);
	const settings = new SettingsStore(storeIO);
	await settings.reload();
	for (const c of connections) expect((await settings.mutate(saveConnectionOp(undefined, c, 'p'))).ok).toBe(true);
	const pendingIO = new MemoryPendingIO(log);
	const pending = new PendingStore(pendingIO, OWN, () => new Date('2026-10-17T00:00:00Z'));
	await pending.load();
	const s3 = new FakeS3(log);
	const abort = new AbortController();
	const sleeps: number[] = [];
	const changed = new Set<string>();
	const refuse: Setup['refuse'] = {};
	let checks = 0;
	let ids = 0;
	const deps: UploaderDeps = {
		pending,
		settings,
		client: s3 as never,
		signal: abort.signal,
		timeoutMs: 15_000,
		check: () => {
			checks++;
			log.push('checkpoint');
			return refuse.reason && checks > (refuse.after ?? 0) ? refuse.reason : undefined;
		},
		sourceUnchanged: (item) => Promise.resolve(!changed.has(item.id)),
		rebuild: () => Promise.resolve(BODY),
		sleep: (ms, signal) => {
			sleeps.push(ms);
			return signal.aborted ? Promise.reject(new Error('aborted')) : Promise.resolve();
		},
		random: () => 0.5,
		now: () => new Date('2026-10-17T00:00:00Z'),
		newId: () => `h${++ids}`,
	};
	log.length = 0;
	return { log, storeIO, settings, pendingIO, pending, s3, abort, deps, sleeps, changed, refuse };
}

function item(id: string, over: Partial<NewPendingItem> = {}): NewPendingItem {
	const c = over.connectionId === 'c2' ? pub : priv;
	return {
		id,
		jobId: 'job-1',
		groupId: 'g-1',
		connectionId: c.id,
		target: `aws:${c.bucket}`,
		classification: c.classification,
		notePath: 'notes/n.md',
		sourcePath: `assets/${id}.png`,
		sourceSha256: SOURCE_A,
		sentSha256: SENT,
		size: BODY.byteLength,
		format: 'png',
		converter: 'c1;orig',
		key: 'k/a.png',
		preparedKey: 'k/a.png',
		phase: 'prepared',
		occurrences: [{ original: `![[${id}.png]]`, alt: id, inTable: false }],
		apply: 'replace',
		...over,
	};
}
const pubItem = (id: string, over: Partial<NewPendingItem> = {}) => item(id, { connectionId: 'c2', ...over });
const stateOf = (s: Setup, id: string) => s.pending.items.find((i) => i.id === id);

describe('sendGroup — order (7-2, 10-3)', () => {
	it('records, saves I1, checks, writes putting, puts, then done-unrecorded, history and delivered', async () => {
		const s = await setup();
		const r = await sendGroup([item('a')], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.log).toEqual([
			'pending:recorded',
			'settings:save', // I1
			'checkpoint',
			's3:head:k/a.png',
			'pending:putting',
			'checkpoint',
			's3:put:k/a.png',
			'pending:done-unrecorded',
			'settings:save', // history
			'pending:delivered',
		]);
		expect(s.settings.current.privateFiles).toEqual([SOURCE_A, SENT].sort());
		expect(s.settings.current.history).toMatchObject([{ id: 'h1', key: 'k/a.png', target: 'aws:example-private', sourceSha256: SOURCE_A, sentSha256: SENT }]);
		expect(s.s3.calls.map((c) => c.timeout)).toEqual([15_000, 60_000]);
		expect(s.s3.objects.get('k/a.png')).toBe(checksumOf(SENT));
	});

	it('sends nothing when the records cannot be written', async () => {
		const s = await setup();
		s.pendingIO.crashAfter = 0;
		expect(await sendGroup([item('a'), item('b')], BODY, s.deps)).toEqual([
			{ id: 'a', outcome: 'not-recorded' },
			{ id: 'b', outcome: 'not-recorded' },
		]);
		expect(s.s3.calls).toEqual([]);
	});
});

describe('sendGroup — results', () => {
	it('reuses an object that already holds the same bytes, without a Put', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		expect(await sendGroup([pubItem('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
	});

	it('moves every item of the group to the alternate key before sending to it', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, s.deps);
		expect(r.map((x) => [x.id, x.outcome, x.key])).toEqual([['a', 'delivered', 'k/a-' + SENT.slice(0, 8) + '.png'], ['b', 'delivered', 'k/a-' + SENT.slice(0, 8) + '.png']]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', `head:k/a-${SENT.slice(0, 8)}.png`, `put:k/a-${SENT.slice(0, 8)}.png`]);
		const altWrite = s.log.findIndex((e) => e === 'pending:recorded,recorded' && s.log.indexOf('s3:head:k/a.png') < s.log.indexOf(e));
		expect(altWrite).toBeLessThan(s.log.indexOf(`s3:head:k/a-${SENT.slice(0, 8)}.png`));
		expect(s.settings.current.history).toHaveLength(2); // one entry per source file
	});

	it('412: the same bytes are reused, other bytes lead to the alternate key', async () => {
		const s = await setup();
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		s.s3.on('put', () => {
			s.s3.objects.set('k/a.png', checksumOf(SENT)); // someone else put the same bytes meanwhile
			throw sdkError(412, 'PreconditionFailed');
		});
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png']);

		const t = await setup();
		t.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		t.s3.on('put', () => {
			t.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
			throw sdkError(412, 'PreconditionFailed');
		});
		const alt = `k/a-${SENT.slice(0, 8)}.png`;
		expect(await sendGroup([item('a')], BODY, t.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: alt }]);
		expect(t.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png', `head:${alt}`, `put:${alt}`]);
	});

	it('409 three times: failed:conflict, the record removed, waits jittered, a checkpoint before every Put', async () => {
		const s = await setup();
		for (let i = 0; i < 3; i++) s.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'failed', reason: 'conflict' }]);
		expect(s.sleeps).toEqual([500, 1000]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'put:k/a.png', 'put:k/a.png']);
		expect(s.log.filter((e) => e === 'checkpoint')).toHaveLength(4);
		expect(s.pending.items).toEqual([]);
	});

	it('digest error once is retried with the same key; twice fails', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(400, 'BadDigest')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		const t = await setup();
		t.s3.on('put', () => Promise.reject(sdkError(400, 'BadDigest'))).on('put', () => Promise.reject(sdkError(400, 'BadDigest')));
		expect(await sendGroup([item('a')], BODY, t.deps)).toEqual([{ id: 'a', outcome: 'failed', reason: 'digest' }]);
	});

	it('an unknown Put outcome is recovered once in recover mode', async () => {
		const s = await setup();
		s.s3.on('put', () => {
			s.s3.objects.set('k/a.png', checksumOf(SENT)); // it did arrive
			throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		});
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png']);
		expect(s.log).toContain('pending:indeterminate');
		expect(stateOf(s, 'a')).toMatchObject({ state: 'delivered', uncertain: true });
	});

	it('still unknown after the recovery: the record stays, uncertain', async () => {
		const s = await setup();
		const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
		s.s3.on('put', timeout).on('put', timeout);
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'indeterminate' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png', 'put:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'indeterminate', uncertain: true, putSent: true });
	});

	it('a Put stopped by our own abort is indeterminate, not stopped', async () => {
		const s = await setup();
		s.s3.on('put', () => {
			s.abort.abort();
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		});
		const r = await sendGroup([item('a')], BODY, s.deps);
		expect(stateOf(s, 'a')).toMatchObject({ uncertain: true, putSent: true });
		expect(r[0]?.outcome).not.toBe('failed');
		expect(s.pending.items).toHaveLength(1);
	});

	it('the checkpoint before the Put refuses: nothing is sent and the record stays resumable, not uncertain', async () => {
		const s = await setup();
		s.refuse.reason = 'connection-changed';
		s.refuse.after = 1; // the Head passes, the Put does not
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'connection-changed' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped', uncertain: false });
		expect((await s.pending.removeFailed(['a'])).ok).toBe(true);
	});

	it('a connection removed from data.json only (no change notification): refused inside the checkpoint', async () => {
		const s = await setup();
		const deps: UploaderDeps = {
			...s.deps,
			sourceUnchanged: () => {
				// A sync tool rewrites data.json; Obsidian has not told the plugin yet.
				const disk = s.storeIO.disk as { connections: StorageConnection[] };
				s.storeIO.disk = { ...disk, connections: disk.connections.filter((c) => c.id !== 'c1') };
				return Promise.resolve(true);
			},
		};
		expect(await sendGroup([item('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'connection-changed' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('I2: a public group with a privately recorded file sends nothing', async () => {
		const s = await setup();
		await sendGroup([item('p', { sourceSha256: SOURCE_B, sentSha256: createHash('sha256').update(OTHER_BODY).digest('hex') })], OTHER_BODY, s.deps);
		s.s3.calls.length = 0;
		const r = await sendGroup([pubItem('x'), pubItem('y', { sourceSha256: SOURCE_B })], BODY, s.deps);
		expect(r).toEqual([
			{ id: 'x', outcome: 'stopped', reason: 'private-recorded' },
			{ id: 'y', outcome: 'stopped', reason: 'private-recorded' },
		]);
		expect(s.s3.calls).toEqual([]);
	});

	it('I1 failure leaves only that item out of a private group', async () => {
		const s = await setup();
		let saves = 0;
		const mutate = s.settings.mutate.bind(s.settings);
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, {
			...s.deps,
			settings: {
				checkpoint: s.settings.checkpoint.bind(s.settings),
				mutate: (op) => (++saves === 1 ? Promise.resolve({ ok: false, error: [], reason: 'save-failed' }) : mutate(op)),
			},
		});
		expect(r).toEqual([
			{ id: 'a', outcome: 'excluded', reason: 'private-not-saved' },
			{ id: 'b', outcome: 'delivered', key: 'k/a.png' },
		]);
		expect(stateOf(s, 'a')).toBeUndefined(); // never sent: removed
		expect(s.settings.current.privateFiles).not.toContain(SOURCE_A);
	});

	it('a source that changed before any Put is removed; after a Put went out it stays unresolved', async () => {
		const s = await setup();
		s.changed.add('a');
		expect(await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, s.deps)).toEqual([
			{ id: 'a', outcome: 'excluded', reason: 'changed' },
			{ id: 'b', outcome: 'delivered', key: 'k/a.png' },
		]);
		expect(stateOf(s, 'a')).toBeUndefined();

		const t = await setup();
		t.s3.on('put', () => {
			t.changed.add('a');
			return Promise.reject(sdkError(409, 'ConditionalRequestConflict'));
		});
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, t.deps);
		expect(r[0]).toEqual({ id: 'a', outcome: 'excluded', reason: 'changed' });
		expect(stateOf(t, 'a')).toMatchObject({ state: 'unresolved' });
	});

	it('candidate key: absent → switch to the prepared key (saved first); unverifiable → stop without a new key', async () => {
		const s = await setup();
		const r = await sendGroup([item('a', { key: 'k/2025/a.png', phase: 'candidate', preparedKey: 'k/2026/a.png' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/2026/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/2025/a.png', 'head:k/2026/a.png', 'put:k/2026/a.png']);

		const t = await setup();
		t.s3.on('head', () => Promise.reject(sdkError(403, 'Forbidden')));
		expect(await sendGroup([item('a', { key: 'k/2025/a.png', phase: 'candidate', preparedKey: 'k/2026/a.png' })], BODY, t.deps)).toEqual([
			{ id: 'a', outcome: 'stopped', reason: 'candidate-unverified' },
		]);
		expect(t.s3.ops()).toEqual(['head:k/2025/a.png']);
	});

	it('history not saved: done-unrecorded, the record stays', async () => {
		const s = await setup();
		let n = 0;
		const mutate = s.settings.mutate.bind(s.settings);
		const r = await sendGroup([item('a')], BODY, {
			...s.deps,
			settings: { checkpoint: s.settings.checkpoint.bind(s.settings), mutate: (op) => (++n === 2 ? Promise.resolve({ ok: false, error: [], reason: 'save-failed' }) : mutate(op)) },
		});
		expect(r).toEqual([{ id: 'a', outcome: 'done-unrecorded', reason: 'history-not-saved', key: 'k/a.png' }]);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'done-unrecorded', uncertain: true });
	});
});

describe('sendGroup — the last check before each request (10-3)', () => {
	/** Runs `change` right before the first request, from inside the job (the source check is the last await). */
	const before = (s: Setup, change: () => Promise<unknown>): UploaderDeps => {
		let done = false;
		return {
			...s.deps,
			sourceUnchanged: async () => {
				if (!done) {
					done = true;
					await change();
				}
				return true;
			},
		};
	};

	it('a public connection blocked because its bucket became private', async () => {
		const s = await setup();
		const deps = before(s, () => s.settings.mutate(saveConnectionOp(undefined, { ...priv, id: 'c3', alias: 'other', bucket: pub.bucket }, 'p')));
		expect(await sendGroup([pubItem('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'connection-changed' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('a connection whose class changed (public → private)', async () => {
		const s = await setup();
		const deps = before(s, () => s.settings.mutate(saveConnectionOp(pub, { ...pub, classification: 'private' }, 'p')));
		expect(await sendGroup([pubItem('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'connection-changed' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('the job aborted just before the request', async () => {
		const s = await setup();
		const deps = before(s, () => Promise.resolve(s.abort.abort()));
		expect(await sendGroup([item('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'aborted' }]);
		expect(s.s3.calls).toEqual([]);
	});
});

describe('sendGroup — more orderings and aborts', () => {
	it('every item holds the alternate key before the Head of that key', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		const alt = `k/a-${SENT.slice(0, 8)}.png`;
		let seen: unknown[] = [];
		s.s3.on('head', () => Promise.resolve({ ChecksumSHA256: checksumOf('0'.repeat(64)) })); // first Head: other content
		s.s3.on('head', () => {
			seen = (JSON.parse(s.pendingIO.files.get(pendingFileName(OWN))!) as { items: { altKey?: string; phase: string }[] }).items.map((i) => [i.altKey, i.phase]);
			return Promise.reject(sdkError(404, 'NotFound'));
		});
		await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, s.deps);
		expect(seen).toEqual([[alt, 'alt'], [alt, 'alt']]);
	});

	it('a Head stopped by our abort is stopped (resumable), not a failed Head', async () => {
		const s = await setup();
		s.s3.on('head', () => {
			s.abort.abort();
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		});
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'aborted' }]);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped' });
	});

	it('an answer that arrives after our abort still counts as unknown for a Put', async () => {
		const s = await setup();
		s.s3.on('put', () => {
			s.abort.abort();
			throw sdkError(403, 'AccessDenied');
		});
		await sendGroup([item('a')], BODY, s.deps);
		expect(stateOf(s, 'a')).toMatchObject({ uncertain: true, putSent: true });
	});

	it('a failure does not remove a record whose object may exist from an earlier session', async () => {
		const s = await setup();
		// Reused at a candidate key earlier (object exists there), then stopped; resumed in send mode.
		s.pendingIO.files.set(
			pendingFileName(OWN),
			JSON.stringify({
				version: 1,
				deviceId: OWN,
				items: [{ ...item('a', { key: 'k/2025/a.png', phase: 'candidate', preparedKey: 'k/2026/a.png' }), state: 'stopped', uncertain: true, putSent: false, createdAt: 't', updatedAt: 't' }],
			}),
		);
		const pending = new PendingStore(s.pendingIO, OWN);
		await pending.load();
		s.s3.on('put', () => Promise.reject(sdkError(403, 'AccessDenied')));
		const r = await resumeGroup(['a'], { ...s.deps, pending });
		expect(r).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'forbidden' }]);
		expect(pending.items).toHaveLength(1);
	});
});

describe('design 15: paths through the uploader', () => {
	const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));

	it('rev.2 uncertainty: unknown Put → recovery Head 403 → re-sent Put 403: the record stays unresolved', async () => {
		const s = await setup();
		s.s3.on('put', timeout).on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		s.s3.on('head', () => Promise.reject(sdkError(403, 'Forbidden'))).on('put', () => Promise.reject(sdkError(403, 'AccessDenied')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'forbidden' }]);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'unresolved', uncertain: true });
	});

	it('rev.2 recovery: re-sent Put 412 → verification Head with other content → unresolved, never an alternate key', async () => {
		const s = await setup();
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound'))).on('put', timeout);
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		s.s3.on('put', () => Promise.reject(sdkError(412, 'PreconditionFailed')));
		s.s3.on('head', () => Promise.resolve({ ChecksumSHA256: checksumOf('0'.repeat(64)) }));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'different-object' }]);
		expect(s.s3.ops().filter((o) => o.startsWith('put:'))).toEqual(['put:k/a.png', 'put:k/a.png']);
	});

	it('rev.4: a putting record resumed while I1 cannot be saved: kept, stopped, no Head and no Put', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		await s.pending.markPutting(['a']);
		const pending = new PendingStore(s.pendingIO, OWN);
		await pending.load();
		s.storeIO.failSave = true;
		const r = await resumeGroup(['a'], { ...s.deps, pending });
		expect(r).toEqual([{ id: 'a', outcome: 'excluded', reason: 'private-not-saved' }]);
		expect(pending.items[0]).toMatchObject({ state: 'stopped', reason: 'private-not-saved', uncertain: true });
		expect(s.s3.calls).toEqual([]);
	});

	it('rev.4: a candidate record resumed: candidate 404 → the recorded prepared key, never a Put to the candidate', async () => {
		const s = await setup();
		await s.pending.add([item('a', { key: 'k/2025/a.png', phase: 'candidate', preparedKey: 'k/2026/a.png' })]);
		const r = await resumeGroup(['a'], s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/2026/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/2025/a.png', 'head:k/2026/a.png', 'put:k/2026/a.png']);
	});

	it('6-4: the class changed during the wait after 409: the next Put is not sent', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		const deps: UploaderDeps = {
			...s.deps,
			sleep: async () => {
				await s.settings.mutate(saveConnectionOp(pub, { ...pub, classification: 'private' }, 'p'));
			},
		};
		expect(await sendGroup([pubItem('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'connection-changed' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped', uncertain: false });
	});

	it('6-4: aborted during the wait after 409: stopped, resumable', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		const deps: UploaderDeps = { ...s.deps, sleep: () => (s.abort.abort(), Promise.reject(new Error('aborted'))) };
		expect(await sendGroup([item('a')], BODY, deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'aborted' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped', uncertain: false });
	});

	it('7-3 row 2: the process ends after the Put reached S3 but before the answer: reused on resume, one object', async () => {
		const s = await setup();
		s.s3.on('put', () => {
			s.s3.objects.set('k/a.png', checksumOf(SENT)); // arrived
			s.pendingIO.crashAfter = s.pendingIO.writes; // nothing more reaches the record file
			s.abort.abort();
			throw Object.assign(new Error('aborted'), { name: 'AbortError' });
		});
		await sendGroup([item('a')], BODY, s.deps);
		s.pendingIO.crashAfter = Infinity;
		const pending = new PendingStore(s.pendingIO, OWN);
		await pending.load();
		expect(pending.items[0]).toMatchObject({ state: 'putting', uncertain: true });
		const r = await resumeGroup(['a'], { ...s.deps, pending, signal: new AbortController().signal });
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png']);
		expect([...s.s3.objects.keys()]).toEqual(['k/a.png']);
	});

	it('I2 matches the sent bytes too: another source that re-encodes to bytes sent privately', async () => {
		const s = await setup();
		await sendGroup([item('p', { sourceSha256: SOURCE_B })], BODY, s.deps); // private: SOURCE_B and SENT recorded
		s.s3.calls.length = 0;
		const r = await sendGroup([pubItem('x', { sourceSha256: 'd'.repeat(64) })], BODY, s.deps);
		expect(r).toEqual([{ id: 'x', outcome: 'stopped', reason: 'private-recorded' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('I2 also covers an item that left the group: a changed private-recorded file stops the public group', async () => {
		const s = await setup();
		await sendGroup([item('p', { sourceSha256: SOURCE_B, sentSha256: createHash('sha256').update(OTHER_BODY).digest('hex') })], OTHER_BODY, s.deps);
		s.s3.calls.length = 0;
		s.changed.add('x');
		const r = await sendGroup([pubItem('x', { sourceSha256: SOURCE_B }), pubItem('y')], BODY, s.deps);
		expect(r).toEqual([
			{ id: 'x', outcome: 'excluded', reason: 'changed' },
			{ id: 'y', outcome: 'stopped', reason: 'private-recorded' },
		]);
		expect(s.s3.calls).toEqual([]);
	});
});

describe('resumeGroup', () => {
	it('recovers a record left in putting: Head absent → rebuild → Put → delivered', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		await s.pending.markPutting(['a']);
		const restarted = new PendingStore(s.pendingIO, OWN);
		await restarted.load();
		const r = await resumeGroup(['a'], { ...s.deps, pending: restarted });
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
	});

	it('never moves to another key in recover mode', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		s.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		expect(await resumeGroup(['a'], s.deps)).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'different-object' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
	});

	it('requests nothing when the recorded storage is no longer the connection’s', async () => {
		const s = await setup();
		await s.pending.add([item('a', { target: 'aws:another-bucket' })]);
		expect(await resumeGroup(['a'], s.deps)).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'target-mismatch' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('cannot rebuild the same bytes: unresolved, no Put', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		expect(await resumeGroup(['a'], { ...s.deps, rebuild: () => Promise.resolve(undefined) })).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'cannot-rebuild' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
	});
});

describe('terminated after the N-th record write, then resumed (7-3, in process)', () => {
	it.each([1, 2, 3])('after write %i: one object, delivered after the resume', async (n) => {
		const s = await setup();
		s.pendingIO.crashAfter = n;
		s.pendingIO.onCrash = () => s.abort.abort();
		await sendGroup([item('a')], BODY, s.deps);
		// A new process: same files, same bucket, a fresh store and signal.
		s.pendingIO.crashAfter = Infinity;
		const pending = new PendingStore(s.pendingIO, OWN);
		await pending.load();
		const left = pending.items.map((i) => i.id);
		if (left.length === 0) return; // nothing recorded yet: nothing to resume, nothing sent
		const r = await resumeGroup(left, { ...s.deps, pending, signal: new AbortController().signal });
		expect(r).toMatchObject([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect([...s.s3.objects.keys()]).toEqual(['k/a.png']);
		expect(pendingFileName(OWN)).toBe(`pending-${OWN}.json`);
	});
});
