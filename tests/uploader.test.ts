import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addPrivateFilesOp, saveConnectionOp } from '../src/settings/ops';
import { SettingsStore } from '../src/settings/store';
import type { StorageConnection } from '../src/settings/types';
import { type NewPendingItem, PendingStore, pendingFileName } from '../src/upload/pending';
import { checksumOf } from '../src/upload/s3';
import { resumeGroup, sendGroup, type UploaderDeps } from '../src/upload/uploader';
import { OWN } from './fixtures/pendingItems';
import { FakeS3, type Log, MemoryPendingIO, MemoryStoreIO, sdkError } from './fixtures/uploadFakes';

const BODY = new TextEncoder().encode('example image bytes');
const SENT = createHash('sha256').update(BODY).digest('hex');
const OTHER_BODY = new TextEncoder().encode('different bytes');
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'c'.repeat(64);

const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };
const pub: StorageConnection = { id: 'c2', alias: 'blog', provider: 'aws-s3', classification: 'public', bucket: 'example-public', region: 'ap-northeast-1', keyTemplate: 'k/{hash}.{ext}' };

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
		sourceChanged: (item) => changed.has(item.id),
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
		contentType: 'image/png',
		converter: 'c1;orig',
		key: 'k/a.png',
		preparedKey: 'k/a.png',
		phase: 'prepared',
		occurrences: [{ original: `![[${id}.png]]`, kind: 'embed', alt: id, inTable: false }],
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
		// A Put has no total limit, only the handler's inactivity limit (design 2-3, rev.5).
		expect(s.s3.calls.map((c) => c.timeout)).toEqual([15_000, 0]);
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

describe('sendGroup — a source change reported right before the Put (10-2)', () => {
	/** Flags `id` as changed once putting has been saved: after every async source check of the group. */
	const changeWhilePutting = (s: Setup, id: string) => {
		const markPutting = s.pending.markPutting.bind(s.pending);
		s.pending.markPutting = async (ids) => {
			const r = await markPutting(ids);
			s.changed.add(id);
			return r;
		};
	};

	it('one file: no Put; ends as a refused Put (not uncertain), so the record goes', async () => {
		const s = await setup();
		changeWhilePutting(s, 'a');
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'excluded', reason: 'changed' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
		expect(stateOf(s, 'a')).toBeUndefined();
	});

	it('two files: the changed one leaves the group, the other is sent', async () => {
		const s = await setup();
		changeWhilePutting(s, 'a');
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, s.deps);
		expect(r).toEqual([
			{ id: 'a', outcome: 'excluded', reason: 'changed' },
			{ id: 'b', outcome: 'delivered', key: 'k/a.png' },
		]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect(stateOf(s, 'a')).toBeUndefined();
		expect(stateOf(s, 'b')).toMatchObject({ state: 'delivered' });
	});

	it('a change of one file reported while another file of the group is checked', async () => {
		const s = await setup();
		const deps: UploaderDeps = {
			...s.deps,
			sourceUnchanged: (i) => {
				// After the Head: the check of b, right before the Put, is when a's event arrives.
				if (i.id === 'b' && s.s3.calls.length === 1) s.changed.add('a');
				return Promise.resolve(!s.changed.has(i.id));
			},
		};
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B })], BODY, deps);
		expect(r).toEqual([
			{ id: 'a', outcome: 'excluded', reason: 'changed' },
			{ id: 'b', outcome: 'delivered', key: 'k/a.png' },
		]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
	});

	it('a resumed group whose source is reported changed is not re-sent', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		changeWhilePutting(s, 'a');
		const r = await resumeGroup(['a'], s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'excluded', reason: 'changed' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
		expect(stateOf(s, 'a')).toBeUndefined();
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

describe('Step 4: privacy and recovery paths', () => {
	const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
	const PUB_PRIVATE_CHECK = 'private-recorded';

	it('a private upload that fails keeps its hashes recorded (Put 403, 409 three times)', async () => {
		const forbidden = await setup();
		forbidden.s3.on('put', () => Promise.reject(sdkError(403, 'AccessDenied')));
		expect((await sendGroup([item('a')], BODY, forbidden.deps))[0]).toMatchObject({ outcome: 'failed' });
		expect(forbidden.settings.current.privateFiles).toEqual([SOURCE_A, SENT].sort());
		const conflict = await setup();
		for (let i = 0; i < 3; i++) conflict.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		expect((await sendGroup([item('a')], BODY, conflict.deps))[0]).toMatchObject({ outcome: 'failed', reason: 'conflict' });
		expect(conflict.settings.current.privateFiles).toEqual([SOURCE_A, SENT].sort());
	});

	it('I1 cannot be saved for the only item: nothing is requested', async () => {
		const s = await setup();
		s.storeIO.failSave = true;
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'excluded', reason: 'private-not-saved' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('missing KMS permission (Head 403 → Put 412 → Head 403): stopped, no alternate key, the record stays', async () => {
		const s = await setup();
		s.s3.on('head', () => Promise.reject(sdkError(403, 'Forbidden')));
		s.s3.on('put', () => Promise.reject(sdkError(412, 'PreconditionFailed')));
		s.s3.on('head', () => Promise.reject(sdkError(403, 'Forbidden')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'stopped', reason: 'permission' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped' });
	});

	it('I2 after a 412: content recorded as private meanwhile is not reused for a public link', async () => {
		const s = await setup();
		s.s3.on('put', async () => {
			await s.settings.mutate(addPrivateFilesOp([SENT]));
			s.s3.objects.set('k/a.png', checksumOf(SENT));
			throw sdkError(412, 'PreconditionFailed');
		});
		const [r] = await sendGroup([pubItem('x')], BODY, s.deps);
		expect(r).toMatchObject({ reason: PUB_PRIVATE_CHECK });
		expect(r?.outcome).not.toBe('delivered');
		expect(r?.key).toBeUndefined();
		expect(s.settings.current.history).toEqual([]);
	});

	it('I2 on resume: a public record whose content became private is not delivered even when the object matches', async () => {
		const s = await setup();
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound'))).on('put', timeout).on('head', timeout);
		expect((await sendGroup([pubItem('x')], BODY, s.deps))[0]).toMatchObject({ outcome: 'indeterminate' });
		await s.settings.mutate(addPrivateFilesOp([SOURCE_A]));
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		s.s3.calls.length = 0;
		const [r] = await resumeGroup(['x'], s.deps);
		expect(r?.outcome).not.toBe('delivered');
		expect(r?.key).toBeUndefined();
		expect(s.s3.ops().filter((o) => o.startsWith('put:'))).toEqual([]);
		expect(s.settings.current.history).toEqual([]);
	});

	it('resumed in the next month: the recorded key is used, one object', async () => {
		const s = await setup();
		const key = 'k/2026/10/a.png';
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound'))).on('put', timeout).on('head', timeout);
		expect((await sendGroup([item('a', { key, preparedKey: key })], BODY, s.deps))[0]).toMatchObject({ outcome: 'indeterminate' });
		const restarted = new PendingStore(s.pendingIO, OWN);
		await restarted.load();
		const r = await resumeGroup(['a'], { ...s.deps, pending: restarted, now: () => new Date('2026-11-02T00:00:00Z') });
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key }]);
		expect(s.s3.ops().every((o) => o.endsWith(key))).toBe(true);
		expect([...s.s3.objects.keys()]).toEqual([key]);
	});

	it('the putting record cannot be written: no Put', async () => {
		const s = await setup();
		s.pendingIO.crashAfter = 1;
		const [r] = await sendGroup([item('a')], BODY, s.deps);
		expect(r?.outcome).not.toBe('delivered');
		expect(s.s3.ops()).not.toContain('put:k/a.png');
	});
});

describe('Step 4: changes that reach data.json during a send (sync, no notification)', () => {
	type Disk = { connections: StorageConnection[]; privateFiles: string[]; aliasBindings: unknown[] };
	/** Rewrites data.json right before the first request, as a sync tool would. */
	const onDisk = (s: Setup, edit: (disk: Disk) => Disk): UploaderDeps => {
		let done = false;
		return {
			...s.deps,
			sourceUnchanged: () => {
				if (!done) {
					done = true;
					s.storeIO.disk = edit(structuredClone(s.storeIO.disk) as Disk);
				}
				return Promise.resolve(true);
			},
		};
	};

	it('a private record of this content arrives: the public group sends nothing', async () => {
		const s = await setup();
		const deps = onDisk(s, (d) => ({ ...d, privateFiles: [...d.privateFiles, SOURCE_A] }));
		expect(await sendGroup([pubItem('x')], BODY, deps)).toEqual([{ id: 'x', outcome: 'stopped', reason: 'private-recorded' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('the public connection became private on disk only: nothing is sent', async () => {
		const s = await setup();
		const deps = onDisk(s, (d) => ({ ...d, connections: d.connections.map((c) => (c.id === 'c2' ? { ...c, classification: 'private' } : c)) }));
		const [r] = await sendGroup([pubItem('x')], BODY, deps);
		expect(r).toMatchObject({ outcome: 'stopped' });
		expect(s.s3.calls).toEqual([]);
		expect(s.settings.current.connections.find((c) => c.id === 'c2')?.classification).toBe('private');
	});

	it('another device bound the alias to another bucket (conflict): nothing is sent', async () => {
		const s = await setup();
		const deps = onDisk(s, (d) => ({ ...d, aliasBindings: [...d.aliasBindings, { alias: 'work', target: 'aws:example-other', classification: 'private' }] }));
		const [r] = await sendGroup([item('a')], BODY, deps);
		expect(r).toMatchObject({ outcome: 'stopped' });
		expect(s.s3.calls).toEqual([]);
	});
});

describe('Step 4: classification across restarts, groups and keys', () => {
	it('after a public connection became private and Obsidian restarted, its content cannot go to another public connection', async () => {
		const s = await setup();
		expect((await sendGroup([pubItem('x')], BODY, s.deps))[0]).toMatchObject({ outcome: 'delivered' });
		expect((await s.settings.mutate(saveConnectionOp(pub, { ...pub, classification: 'private' }, 'p'))).ok).toBe(true);
		const restarted = new SettingsStore(s.storeIO);
		await restarted.reload();
		const other: StorageConnection = { ...pub, id: 'c4', alias: 'site', bucket: 'example-public-2' };
		expect((await restarted.mutate(saveConnectionOp(undefined, other, 'p'))).ok).toBe(true);
		s.s3.calls.length = 0;
		const r = await sendGroup([item('y', { connectionId: 'c4', classification: 'public', target: 'aws:example-public-2', key: 'k/y.png', preparedKey: 'k/y.png' })], BODY, { ...s.deps, settings: restarted });
		expect(r).toEqual([{ id: 'y', outcome: 'stopped', reason: 'private-recorded' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('a private group of two sources with the same sent bytes records both sources, two records and two history entries', async () => {
		const s = await setup();
		const r = await sendGroup([item('a'), item('b', { sourceSha256: SOURCE_B, sourcePath: 'assets/b.png' })], BODY, s.deps);
		expect(r.map((x) => x.outcome)).toEqual(['delivered', 'delivered']);
		expect(s.settings.current.privateFiles).toEqual([SOURCE_A, SOURCE_B, SENT].sort());
		expect(s.pending.items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(s.settings.current.history.map((h) => h.sourceSha256).sort()).toEqual([SOURCE_A, SOURCE_B].sort());
		expect(s.s3.ops().filter((o) => o.startsWith('put:'))).toHaveLength(1);
	});

	it('a collision at the alternate key too: failed, never a third key', async () => {
		const s = await setup();
		const alt = `k/a-${SENT.slice(0, 8)}.png`;
		s.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		s.s3.objects.set(alt, checksumOf('1'.repeat(64)));
		const [r] = await sendGroup([item('a')], BODY, s.deps);
		expect(r).toMatchObject({ outcome: 'failed', reason: 'collision' });
		expect(new Set(s.s3.ops().map((o) => o.split(':')[1]))).toEqual(new Set(['k/a.png', alt]));
	});

	it('resume after the connection’s bucket was edited on disk: no Head and no Put', async () => {
		const s = await setup();
		await s.pending.add([item('a')]);
		await s.pending.markPutting(['a']);
		const disk = s.storeIO.disk as { connections: StorageConnection[] };
		s.storeIO.disk = { ...disk, connections: disk.connections.map((c) => (c.id === 'c1' ? { ...c, bucket: 'example-moved' } : c)) };
		await s.settings.reload();
		const r = await resumeGroup(['a'], s.deps);
		expect(r[0]).toMatchObject({ reason: 'target-mismatch' });
		expect(s.s3.calls).toEqual([]);
	});
});

describe('Step 4: the reason of a refused Put', () => {
	it('404 on a Put means the bucket is missing: failed:not-found, nothing left', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(404, 'NoSuchBucket')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'failed', reason: 'not-found' }]);
		expect(s.pending.items).toEqual([]);
	});

	it('another 4xx stays failed:failed', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(400, 'InvalidRequest')));
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'failed', reason: 'failed' }]);
	});
});

describe('Step 4: 6-6 — the state kept for each outcome', () => {
	const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
	const absent = () => Promise.reject(sdkError(404, 'NotFound'));
	/** A record left in putting by an earlier session, resumed in recover mode. */
	const recovering = async (script: (s: Setup) => void) => {
		const s = await setup();
		await s.pending.add([item('a')]);
		await s.pending.markPutting(['a']);
		const pending = new PendingStore(s.pendingIO, OWN);
		await pending.load();
		script(s);
		const r = await resumeGroup(['a'], { ...s.deps, pending });
		return { s, r: r[0], kept: pending.items.find((i) => i.id === 'a') };
	};

	it.each([
		['409 up to the limit', (s: Setup) => {
			s.s3.on('head', absent);
			for (let i = 0; i < 3; i++) s.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		}],
		['digest twice', (s: Setup) => {
			s.s3.on('head', absent);
			for (let i = 0; i < 2; i++) s.s3.on('put', () => Promise.reject(sdkError(400, 'BadDigest')));
		}],
		['Put forbidden', (s: Setup) => {
			s.s3.on('head', absent).on('put', () => Promise.reject(sdkError(403, 'AccessDenied')));
		}],
		['412, then the Head is forbidden', (s: Setup) => {
			s.s3.on('head', absent).on('put', () => Promise.reject(sdkError(412, 'PreconditionFailed'))).on('head', () => Promise.reject(sdkError(403, 'Forbidden')));
		}],
	] as const)('recover mode, %s: unresolved, the record kept', async (_, script) => {
		const { r, kept } = await recovering(script);
		expect(r?.outcome).toBe('unresolved');
		expect(kept?.state).toBe('unresolved');
	});

	it('recover mode, the Head is unknown: the record stays indeterminate', async () => {
		const { r, kept } = await recovering((s) => void s.s3.on('head', timeout));
		expect(r?.outcome).toBe('indeterminate');
		expect(kept).toMatchObject({ state: 'indeterminate', uncertain: true });
	});

	it('recover mode, the Put is unknown: the record stays indeterminate', async () => {
		const { r, kept } = await recovering((s) => void s.s3.on('head', absent).on('put', timeout));
		expect(r?.outcome).toBe('indeterminate');
		expect(kept).toMatchObject({ state: 'indeterminate', uncertain: true });
	});

	it('recover mode, aborted before the Head: stopped, uncertain unchanged', async () => {
		const { r, kept } = await recovering((s) => s.abort.abort());
		expect(r).toMatchObject({ outcome: 'stopped', reason: 'aborted' });
		expect(kept).toMatchObject({ state: 'stopped', uncertain: true });
	});

	it('send mode, the Head of a new key is unknown: failed:head, the record removed', async () => {
		const s = await setup();
		s.s3.on('head', timeout);
		expect(await sendGroup([item('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'failed', reason: 'head' }]);
		expect(s.pending.items).toEqual([]);
	});

	it('send mode, the candidate key cannot be checked (timeout): stopped:candidate-unverified, never a Put', async () => {
		const s = await setup();
		s.s3.on('head', timeout);
		const r = await sendGroup([item('a', { key: 'k/old.png', phase: 'candidate', preparedKey: 'k/a.png' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'stopped', reason: 'candidate-unverified' }]);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped', reason: 'candidate-unverified' });
		expect(s.s3.ops()).toEqual(['head:k/old.png']);
	});

	it('send mode, the candidate key holds other content: the prepared key is used', async () => {
		const s = await setup();
		s.s3.objects.set('k/old.png', checksumOf('0'.repeat(64)));
		const r = await sendGroup([item('a', { key: 'k/old.png', phase: 'candidate', preparedKey: 'k/a.png' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(s.s3.ops()).toEqual(['head:k/old.png', 'head:k/a.png', 'put:k/a.png']);
	});

	it('6-4: data.json becomes unreadable during the wait after 409: the next Put is not sent', async () => {
		const s = await setup();
		s.s3.on('put', () => Promise.reject(sdkError(409, 'ConditionalRequestConflict')));
		const deps: UploaderDeps = {
			...s.deps,
			check: () => (s.settings.readOnly ? 'read-only' : undefined),
			sleep: () => {
				s.storeIO.disk = undefined;
				return s.settings.reload().then(() => undefined);
			},
		};
		const [r] = await sendGroup([item('a')], BODY, deps);
		expect(r).toMatchObject({ outcome: 'stopped', reason: 'read-only' });
		expect(s.s3.ops().filter((o) => o.startsWith('put:'))).toHaveLength(1);
	});
});

describe('Step 4: I1 for hashes that are already recorded', () => {
	it('a save that would fail is not needed: the item stays in the group and is checked by Head', async () => {
		const s = await setup();
		expect((await sendGroup([item('a')], BODY, s.deps))[0]).toMatchObject({ outcome: 'delivered' });
		s.storeIO.failSave = true;
		s.s3.calls.length = 0;
		const [r] = await sendGroup([item('b', { sourcePath: 'assets/b.png' })], BODY, s.deps);
		expect(r?.outcome).not.toBe('excluded');
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
	});
});

describe('delivery form of public objects (I14, design 3-4 and 3-5)', () => {
	const ALT = `k/a-${SENT.slice(0, 8)}.png`;

	it('does not reuse a public object with the same bytes but another Content-Type; puts at the alternate key with its own', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		s.s3.types.set('k/a.png', 'text/html');
		expect(await sendGroup([pubItem('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: ALT }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png', `head:${ALT}`, `put:${ALT}`]);
		expect(s.s3.types.get(ALT)).toBe('image/png');
		expect(stateOf(s, 'a')?.deliveryChecked).toBe(true);
	});

	it('does not reuse a public object that carries a Content-Disposition', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		s.s3.dispositions.set('k/a.png', 'inline');
		expect((await sendGroup([pubItem('a')], BODY, s.deps))[0]?.key).toBe(ALT);
	});

	it('records a public reuse as checked, and a private reuse (bytes only) as not checked', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		await sendGroup([pubItem('a')], BODY, s.deps);
		expect(stateOf(s, 'a')?.deliveryChecked).toBe(true);
		const p = await setup();
		p.s3.objects.set('k/a.png', checksumOf(SENT));
		p.s3.types.set('k/a.png', 'text/html');
		expect(await sendGroup([item('a')], BODY, p.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(p.s3.ops()).toEqual(['head:k/a.png']);
		expect(stateOf(p, 'a')?.deliveryChecked).toBe(false);
	});

	it('never puts a public item of a format that may not be public, though its Head is allowed', async () => {
		const s = await setup();
		const r = await sendGroup([pubItem('a', { format: 'svg', contentType: 'image/svg+xml' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'stopped', reason: 'public-format' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.png']);
		expect(stateOf(s, 'a')).toMatchObject({ state: 'stopped', putSent: true, uncertain: false });
	});
});

describe('sendGroup — files other than images (design 3-3, 3-5, 3-7)', () => {
	const pdf = (id: string, over: Partial<NewPendingItem> = {}) =>
		item(id, { sourcePath: `assets/${id}.pdf`, format: 'pdf', contentType: 'application/pdf', key: 'k/a.pdf', preparedKey: 'k/a.pdf', ...over });

	it('reads the bytes right before the first Put and keeps them for the recovery in the same group', async () => {
		const s = await setup();
		let rebuilds = 0;
		let checks = 0;
		const deps: UploaderDeps = {
			...s.deps,
			rebuild: () => {
				rebuilds++;
				return Promise.resolve(BODY);
			},
			sourceUnchanged: () => {
				checks++;
				return Promise.resolve(true);
			},
		};
		s.s3.on('put', () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
		expect(await sendGroup([pdf('a')], undefined, deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.pdf' }]);
		// Put (unknown) → recover-check Head 404 → resend-check → Put again with the held bytes.
		expect(s.s3.ops()).toEqual(['head:k/a.pdf', 'put:k/a.pdf', 'head:k/a.pdf', 'put:k/a.pdf']);
		expect(rebuilds).toBe(1);
		// Before the first Put (send mode) and before the re-send: the sources are still checked.
		expect(checks).toBeGreaterThanOrEqual(2);
		expect(s.s3.types.get('k/a.pdf')).toBe('application/pdf');
	});

	it('a source changed before the re-send of the held bytes: unresolved, no second Put', async () => {
		const s = await setup();
		let putDone = false;
		const deps: UploaderDeps = { ...s.deps, sourceUnchanged: () => Promise.resolve(!putDone) };
		s.s3.on('put', () => {
			putDone = true;
			return Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
		});
		expect(await sendGroup([pdf('a')], undefined, deps)).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'cannot-rebuild' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.pdf', 'put:k/a.pdf', 'head:k/a.pdf']);
	});

	it('bytes that are no longer the recorded format are not sent: unresolved', async () => {
		const s = await setup();
		const r = await sendGroup([pdf('a')], undefined, { ...s.deps, rebuild: () => Promise.resolve('format-changed' as const) });
		expect(r).toEqual([{ id: 'a', outcome: 'unresolved', reason: 'format-changed' }]);
		expect(s.s3.ops()).toEqual(['head:k/a.pdf']);
	});

	it('public: an item whose format needs confirming is never put unconfirmed (I15), but may be reused', async () => {
		const s = await setup();
		expect(await sendGroup([pubItem('x', { format: 'pdf', contentType: 'application/pdf', key: 'p/x.pdf', preparedKey: 'p/x.pdf' })], undefined, s.deps)).toEqual([
			{ id: 'x', outcome: 'excluded', reason: 'needs-confirmation' },
		]);
		expect(s.s3.ops()).toEqual(['head:p/x.pdf']);
		// 4-5: never put, so the record goes.
		expect(s.pending.items).toEqual([]);

		const t = await setup();
		t.s3.objects.set('p/y.pdf', checksumOf(SENT));
		t.s3.types.set('p/y.pdf', 'application/pdf');
		expect(await sendGroup([pubItem('y', { format: 'pdf', contentType: 'application/pdf', key: 'p/y.pdf', preparedKey: 'p/y.pdf' })], undefined, t.deps)).toEqual([
			{ id: 'y', outcome: 'delivered', key: 'p/y.pdf' },
		]);
		expect(t.s3.ops()).toEqual(['head:p/y.pdf']);

		const u = await setup();
		const confirmed = { ...u.deps, isConfirmed: () => true };
		expect(await sendGroup([pubItem('z', { format: 'pdf', contentType: 'application/pdf', key: 'p/z.pdf', preparedKey: 'p/z.pdf' })], undefined, confirmed)).toEqual([
			{ id: 'z', outcome: 'delivered', key: 'p/z.pdf' },
		]);
		expect(u.s3.types.get('p/z.pdf')).toBe('application/pdf');
	});
});

describe('sendGroup — I15 in a mixed group (design 4-2, 4-5)', () => {
	const pdf = (id: string, over: Partial<NewPendingItem> = {}) =>
		pubItem(id, { sourcePath: `assets/${id}.pdf`, format: 'pdf', contentType: 'application/pdf', key: 'p/a.pdf', preparedKey: 'p/a.pdf', ...over });

	it('puts only the confirmed items; an unconfirmed one never sent leaves with its record', async () => {
		const s = await setup();
		const deps = { ...s.deps, isConfirmed: (i: { id: string }) => i.id === 'a' };
		expect(await sendGroup([pdf('a'), pdf('b')], undefined, deps)).toEqual(
			expect.arrayContaining([
				{ id: 'a', outcome: 'delivered', key: 'p/a.pdf' },
				{ id: 'b', outcome: 'excluded', reason: 'needs-confirmation' },
			]),
		);
		expect(s.s3.ops()).toEqual(['head:p/a.pdf', 'put:p/a.pdf']);
		expect(s.pending.items.map((i) => i.id)).toEqual(['a']);
	});

	it('nothing confirmed: no Put at all', async () => {
		const s = await setup();
		await sendGroup([pdf('a'), pdf('b')], undefined, s.deps);
		expect(s.s3.ops()).toEqual(['head:p/a.pdf']);
		expect(s.pending.items).toEqual([]);
	});

	it('an unconfirmed item that was sent before stays stopped in a group of its own, even if every Put was rejected', async () => {
		const s = await setup();
		const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
		s.s3.on('put', timeout).on('put', timeout);
		await sendGroup([pdf('a'), pdf('b')], undefined, { ...s.deps, isConfirmed: () => true });
		expect(s.pending.items.map((i) => [i.id, i.state, i.putSent, i.groupId])).toEqual([
			['a', 'indeterminate', true, 'g-1'],
			['b', 'indeterminate', true, 'g-1'],
		]);
		s.s3.calls.length = 0;
		const r = await resumeGroup(['a', 'b'], { ...s.deps, isConfirmed: (i) => i.id === 'a' });
		expect(r).toEqual(expect.arrayContaining([{ id: 'a', outcome: 'delivered', key: 'p/a.pdf' }, { id: 'b', outcome: 'stopped', reason: 'needs-confirmation' }]));
		const b = stateOf(s, 'b')!;
		expect([b.state, b.reason, b.key, b.groupId === 'g-1']).toEqual(['stopped', 'needs-confirmation', 'p/a.pdf', false]);
	});

	it('setting an unconfirmed item aside cannot be written: nothing is put, and both stay in their group', async () => {
		const s = await setup();
		const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
		s.s3.on('put', timeout).on('put', timeout);
		await sendGroup([pdf('a'), pdf('b')], undefined, { ...s.deps, isConfirmed: () => true });
		s.s3.calls.length = 0;
		s.pending.setAsideUnconfirmed = () => Promise.resolve({ ok: false, reason: 'write-failed' });
		const r = await resumeGroup(['a', 'b'], { ...s.deps, isConfirmed: (i) => i.id === 'a' });
		expect(r).toEqual([
			{ id: 'a', outcome: 'stopped', reason: 'record-failed' },
			{ id: 'b', outcome: 'stopped', reason: 'record-failed' },
		]);
		expect(s.s3.calls.filter((c) => c.op === 'put')).toEqual([]);
		expect(s.pending.items.map((i) => i.groupId)).toEqual(['g-1', 'g-1']);
	});
});

describe('Step 4: public formats and the classification rules with files other than images', () => {
	const ALT = `k/a-${SENT.slice(0, 8)}.png`;
	const timeout = () => Promise.reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
	const privPdf = (id: string, over: Partial<NewPendingItem> = {}) =>
		item(id, { sourcePath: `assets/${id}.pdf`, format: 'pdf', contentType: 'application/pdf', key: 'k/a.pdf', preparedKey: 'k/a.pdf', ...over });
	const pubPdf = (id: string, over: Partial<NewPendingItem> = {}) =>
		pubItem(id, { sourcePath: `assets/${id}.pdf`, format: 'pdf', contentType: 'application/pdf', key: 'p/a.pdf', preparedKey: 'p/a.pdf', ...over });
	const puts = (s: Setup) => s.s3.calls.filter((c) => c.op === 'put').map((c) => c.key);

	it('I1: a private PDF is recorded as private content before its Put', async () => {
		const s = await setup();
		expect(await sendGroup([privPdf('a')], BODY, s.deps)).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.pdf' }]);
		expect(s.settings.current.privateFiles).toEqual(expect.arrayContaining([SOURCE_A, SENT]));
	});

	it('I1: a private PDF whose record cannot be saved is left out, never put', async () => {
		const s = await setup();
		const r = await sendGroup([privPdf('a')], BODY, {
			...s.deps,
			settings: { checkpoint: s.settings.checkpoint.bind(s.settings), mutate: () => Promise.resolve({ ok: false, error: [], reason: 'save-failed' }) },
		});
		expect(r).toEqual([{ id: 'a', outcome: 'excluded', reason: 'private-not-saved' }]);
		expect(puts(s)).toEqual([]);
	});

	it('I2: a confirmed public PDF whose bytes were sent to private storage sends nothing', async () => {
		const s = await setup();
		await sendGroup([privPdf('p', { sourceSha256: SOURCE_B })], BODY, s.deps);
		s.s3.calls.length = 0;
		const r = await sendGroup([pubPdf('x')], BODY, { ...s.deps, isConfirmed: () => true });
		expect(r).toEqual([{ id: 'x', outcome: 'stopped', reason: 'private-recorded' }]);
		expect(s.s3.calls).toEqual([]);
	});

	it('I14 (e): a history candidate with the same bytes but another Content-Type is not reused', async () => {
		const s = await setup();
		s.s3.objects.set('k/old.png', checksumOf(SENT));
		s.s3.types.set('k/old.png', 'application/octet-stream');
		const r = await sendGroup([pubItem('a', { key: 'k/old.png', phase: 'candidate', preparedKey: 'k/a.png' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: 'k/a.png' }]);
		expect(puts(s)).toEqual(['k/a.png']);
		expect(s.s3.types.get('k/a.png')).toBe('image/png');
	});

	it('I14 (e): after 412, an object with the same bytes but another Content-Type is not reused', async () => {
		const s = await setup();
		s.s3.objects.set('k/a.png', checksumOf(SENT));
		s.s3.types.set('k/a.png', 'text/html');
		// The first Head saw nothing; the Put then meets the object another tool wrote meanwhile.
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		const r = await sendGroup([pubItem('a')], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'delivered', key: ALT }]);
		expect(puts(s)).toEqual(['k/a.png', ALT]);
		expect(s.s3.types.get(ALT)).toBe('image/png');
	});

	it('I14 (e): an unknown Put result that turns out to be another Content-Type is not taken as delivered', async () => {
		const s = await setup();
		s.s3.on('put', () => {
			s.s3.objects.set('k/a.png', checksumOf(SENT));
			s.s3.types.set('k/a.png', 'text/html');
			return timeout();
		});
		const [r] = await sendGroup([pubItem('a')], BODY, s.deps);
		expect(r).toEqual({ id: 'a', outcome: 'unresolved', reason: 'different-delivery' });
		expect(s.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/a.png']);
	});

	it.each([
		['the history candidate is gone (404)', (s: Setup) => void s],
		['the history candidate holds other bytes', (s: Setup) => void s.s3.objects.set('p/old.pdf', checksumOf('0'.repeat(64)))],
	])('I15: an unconfirmed PDF is not put when %s', async (_label, arrange) => {
		const s = await setup();
		arrange(s);
		const r = await sendGroup([pubPdf('a', { key: 'p/old.pdf', phase: 'candidate', preparedKey: 'p/a.pdf' })], BODY, s.deps);
		expect(r).toEqual([{ id: 'a', outcome: 'excluded', reason: 'needs-confirmation' }]);
		expect(puts(s)).toEqual([]);
	});

	it('I15: after a 412 in a mixed group, only the confirmed item is put again', async () => {
		const s = await setup();
		s.s3.objects.set('p/a.pdf', checksumOf('0'.repeat(64)));
		s.s3.on('head', () => Promise.reject(sdkError(404, 'NotFound')));
		const r = await sendGroup([pubPdf('a'), pubPdf('b')], BODY, { ...s.deps, isConfirmed: (i) => i.id === 'a' });
		expect(r).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'a', outcome: 'delivered' }), { id: 'b', outcome: 'excluded', reason: 'needs-confirmation' }]));
		expect(stateOf(s, 'b')).toBeUndefined();
		expect(puts(s).length).toBeGreaterThan(0);
	});
});
