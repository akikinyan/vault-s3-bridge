import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { profileOf } from '../src/settings/device';
import { addPrivateFilesOp, appendHistoryOp, deleteConnectionOp, saveConnectionOp } from '../src/settings/ops';
import { SettingsStore } from '../src/settings/store';
import type { HistoryEntry, StorageConnection } from '../src/settings/types';
import type { DecodedImage, Encoder } from '../src/upload/convert';
import { sha256Hex } from '../src/upload/convert';
import { parseEmbeds } from '../src/upload/detect';
import {
	type CommandDeps,
	confirmedValues,
	copyDelivered,
	JobLock,
	type JobPlan,
	prepareJob,
	type PrepareDeps,
	type RunDeps,
	runJob,
	inExcludedFolder,
	resumableGroups,
	resumeCommand,
	type ResumeDeps,
	resumeJob,
	resumeTargets,
	type SourceFile,
	uploadCommand,
} from '../src/upload/job';
import { PendingStore } from '../src/upload/pending';
import type { EditorLike, NoteAccess } from '../src/upload/rewrite';
import { checksumOf } from '../src/upload/s3';
import { OWN } from './fixtures/pendingItems';
import { FakeS3, type Log, MemoryPendingIO, MemoryStoreIO, sdkError } from './fixtures/uploadFakes';

const img = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url)));
const PNG_A = img('png-plain.png');
const PNG_B = img('chrome-out.png');
const OUT = img('chrome-out.png'); // what the fake encoder returns for PNG (300x200, no metadata)

const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{filename}.{ext}' };
const pub: StorageConnection = {
	id: 'c2',
	alias: 'blog',
	provider: 'aws-s3',
	classification: 'public',
	bucket: 'example-public',
	region: 'ap-northeast-1',
	publicBaseUrl: 'https://cdn.example.com/',
	keyTemplate: 'p/{hash}.{ext}',
};

class FakeEncoder implements Encoder {
	readonly electronVersion = '38.0.0';
	decodes = 0;
	decode(): Promise<DecodedImage> {
		this.decodes++;
		return Promise.resolve({ width: 300, height: 200, encode: () => Promise.resolve(OUT), close: () => undefined });
	}
}

class FakeEditor implements EditorLike {
	transactions = 0;
	constructor(public value: string) {}
	getValue(): string {
		return this.value;
	}
	offsetToPos(offset: number) {
		const before = this.value.slice(0, offset).split('\n');
		return { line: before.length - 1, ch: before[before.length - 1]!.length };
	}
	private toOffset(pos: { line: number; ch: number }): number {
		return this.value.split('\n').slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) + pos.ch;
	}
	transaction(tx: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }): void {
		this.transactions++;
		const ranges = tx.changes.map((c) => ({ from: this.toOffset(c.from), to: this.toOffset(c.to), text: c.text })).sort((a, b) => b.from - a.from);
		for (const r of ranges) this.value = this.value.slice(0, r.from) + r.text + this.value.slice(r.to);
	}
}

interface World {
	log: Log;
	storeIO: MemoryStoreIO;
	settings: SettingsStore;
	pendingIO: MemoryPendingIO;
	pending: PendingStore;
	s3: FakeS3;
	encoder: FakeEncoder;
	files: Map<string, Uint8Array>;
	reads: string[];
	changed: Set<string>;
	disk: { text: string | undefined };
	editors: FakeEditor[];
	copied: string[];
	copyFails: boolean;
	credentialsFail: boolean;
	abort: AbortController;
	prep: PrepareDeps;
	run: RunDeps;
}

let counter = 0;
const newId = () => `id-${++counter}`;

async function world(connections: StorageConnection[] = [priv, pub], note = ''): Promise<World> {
	const log: Log = [];
	const storeIO = new MemoryStoreIO(log);
	const settings = new SettingsStore(storeIO);
	await settings.reload();
	for (const c of connections) expect((await settings.mutate(saveConnectionOp(undefined, c, 'p'))).ok).toBe(true);
	const pendingIO = new MemoryPendingIO(log);
	const pending = new PendingStore(pendingIO, OWN, () => new Date('2026-10-17T00:00:00Z'));
	await pending.load();
	const files = new Map<string, Uint8Array>([
		['img/a.png', PNG_A],
		['img/b.png', PNG_B],
		['img/a copy.png', PNG_A],
	]);
	const w: World = {
		log,
		storeIO,
		settings,
		pendingIO,
		pending,
		s3: new FakeS3(log),
		encoder: new FakeEncoder(),
		files,
		reads: [],
		changed: new Set(),
		disk: { text: note },
		editors: [],
		copied: [],
		copyFails: false,
		credentialsFail: false,
		abort: new AbortController(),
		prep: undefined as never,
		run: undefined as never,
	};
	const source = (path: string): SourceFile | undefined => {
		const bytes = w.files.get(path);
		if (!bytes) return undefined;
		const name = path.slice(path.lastIndexOf('/') + 1);
		return {
			path,
			basename: name.slice(0, name.lastIndexOf('.')),
			size: bytes.length,
			read: () => {
				w.reads.push(path);
				return Promise.resolve(w.files.get(path)!);
			},
		};
	};
	w.prep = { resolveLink: (p) => source(p.startsWith('img/') ? p : `img/${p}`), encoder: w.encoder, now: () => new Date(2026, 9, 17), newId };
	const note_: NoteAccess = {
		openEditors: () => w.editors,
		wasOpenAtStart: false,
		exists: () => w.disk.text !== undefined,
		process: (fn) => {
			const next = fn(w.disk.text!);
			w.disk.text = next;
			return Promise.resolve(next);
		},
		read: () => Promise.resolve(w.disk.text!),
	};
	w.run = {
		settings,
		pending,
		client: () => (w.credentialsFail ? Promise.reject(new Error('sso')) : Promise.resolve(w.s3 as never)),
		timeoutMs: 15_000,
		signal: w.abort.signal,
		authGeneration: (id) => profileOf(settings.device, id)?.generation,
		sourceChanged: (p) => w.changed.has(p),
		readSource: (p) => Promise.resolve(w.files.get(p)),
		note: note_,
		copy: (text) => {
			if (w.copyFails) return Promise.resolve(false);
			w.copied.push(text);
			return Promise.resolve(true);
		},
		sleep: () => Promise.resolve(),
		random: () => 0.5,
		now: () => new Date('2026-10-17T00:00:00Z'),
		newId,
	};
	return w;
}

async function plan(w: World, note: string, connection: StorageConnection = priv): Promise<JobPlan> {
	const parsed = parseEmbeds(note);
	if (!parsed.ok) throw new Error('unparsable');
	const r = await prepareJob({ notePath: 'notes/日報.md', snapshot: note, embeds: parsed.embeds, connection: w.settings.current.connections.find((c) => c.id === connection.id)!, settings: w.settings.current }, w.prep);
	if (!r.ok) throw new Error(r.reason);
	return r.plan;
}

const confirm = (w: World, c: StorageConnection, apply: 'replace' | 'copy' = 'replace') =>
	confirmedValues(w.settings.current.connections.find((x) => x.id === c.id)!, profileOf(w.settings.device, c.id)?.generation, apply);

describe('prepareJob (10-1 step 4, 8-4, 6-0)', () => {
	it('writes nothing, sends nothing; groups by sentSha256 and keeps one item per source with every occurrence', async () => {
		const note = '![[a.png]] x ![[b.png|300]] y ![[a.png|図]] z ![[a copy.png]]';
		const w = await world();
		const before = { pending: w.pendingIO.writes, log: [...w.log] };
		const p = await plan(w, note);
		expect(w.pendingIO.writes).toBe(before.pending);
		expect(w.log).toEqual(before.log);
		expect(w.s3.calls).toEqual([]);
		// Private, no stripping: the original bytes. a.png and "a copy.png" have the same bytes: one group.
		expect(p.groups).toHaveLength(2);
		const [ga, gb] = p.groups;
		expect(ga!.files.map((f) => f.sourcePath)).toEqual(['img/a.png', 'img/a copy.png']);
		expect(ga!.files[0]!.occurrences.map((o) => o.original)).toEqual(['![[a.png]]', '![[a.png|図]]']);
		expect(ga!.key).toBe('k/a.png'); // the first file's prepared key, for both files
		expect(ga!.preparedKey).toBe('k/a.png');
		expect(ga!.sentSha256).toBe(sha256Hex(PNG_A));
		expect(gb!.files[0]!.occurrences[0]!.markdown).toBe('![b|300](s3-bridge://work/k/b.png)');
		// One read per source, even when embedded twice.
		expect(w.reads).toEqual(['img/a.png', 'img/b.png', 'img/a copy.png']);
	});

	it('uses the latest history entry for the same target and sentSha256 as the candidate key', async () => {
		const w = await world();
		const h = (key: string, at: string, target = 'aws:example-private'): HistoryEntry => ({
			id: key,
			target,
			key,
			classification: 'private',
			sourceSha256: sha256Hex(PNG_A),
			sentSha256: sha256Hex(PNG_A),
			size: 1,
			format: 'png',
			converter: 'c1;orig',
			at,
		});
		await w.settings.mutate(appendHistoryOp([h('old.png', '2026-01-01T00:00:00Z'), h('new.png', '2026-02-01T00:00:00Z'), h('other.png', '2026-03-01T00:00:00Z', 'aws:example-public')]));
		const p = await plan(w, '![[a.png]]');
		expect(p.groups[0]).toMatchObject({ key: 'new.png', preparedKey: 'k/a.png', phase: 'candidate' });
		expect(p.groups[0]!.files[0]!.occurrences[0]!.markdown).toBe('![a](s3-bridge://work/new.png)');
	});

	it('lists every non-target with its reason', async () => {
		const w = await world();
		w.files.set('img/n.md', new TextEncoder().encode('# note'));
		const note = [
			'%% ![[a.png]] %%',
			'![[a.png|1|2]]',
			'![[a.png#x]]',
			'![](https://example.com/a.png)',
			'![[missing.png]]',
			'![[n.md]]',
			'![](img/%E0%A4%A.png)',
			'> | x | y |',
			'> |---|---|',
			'> | ![[a.png\\|9]] | y |',
			'',
			'- ![[b.png|1]]',
		].join('\n');
		const p = await plan(w, note);
		expect(p.skipped.map((s) => [s.original, s.reason])).toEqual([
			['![[a.png]]', 'comment'],
			['![[a.png|1|2]]', 'multiple-pipes'],
			['![[a.png#x]]', 'subpath'],
			['![[missing.png]]', 'not-found'],
			['![[n.md]]', 'unsupported'],
			['![](img/%E0%A4%A.png)', 'unparsable'],
			['![[a.png\\|9]]', 'nested-table'],
		]);
		// The list item without a table is a target; external URLs are not embeds at all (8-2).
		expect(p.groups.flatMap((g) => g.files.map((f) => f.sourcePath))).toEqual(['img/b.png']);
	});

	it('decodes Markdown link paths only; a wiki path is used as written', async () => {
		const w = await world();
		w.files.set('img/100%.png', PNG_B);
		const p = await plan(w, '![](a%20copy.png) ![[100%.png]] ![](100%.png)');
		expect(p.groups.flatMap((g) => g.files.map((f) => f.sourcePath))).toEqual(['img/a copy.png', 'img/100%.png']);
		expect(p.skipped).toEqual([{ offset: 32, original: '![](100%.png)', reason: 'unparsable' }]);
	});

	it('public: re-encodes, skips files recorded as private, and needs a valid public base URL', async () => {
		const w = await world();
		await w.settings.mutate(addPrivateFilesOp([sha256Hex(PNG_A)]));
		const p = await plan(w, '![[a.png]] ![[b.png]]', pub);
		expect(p.skipped).toEqual([{ offset: 0, original: '![[a.png]]', reason: 'private-recorded' }]);
		expect(p.groups[0]).toMatchObject({ reencoded: true, sentSha256: sha256Hex(OUT), converter: 'c1;png;electron=38.0.0' });
		expect(p.groups[0]!.files[0]!.occurrences[0]!.markdown).toBe(`![](https://cdn.example.com/p/${sha256Hex(OUT).slice(0, 16)}.png)`);
		const parsed = parseEmbeds('![[a.png]]');
		if (!parsed.ok) throw new Error();
		for (const publicBaseUrl of [undefined, 'http://cdn.example.com']) {
			const c = { ...w.settings.current.connections.find((x) => x.id === 'c2')!, publicBaseUrl };
			expect(await prepareJob({ notePath: 'n.md', snapshot: '', embeds: parsed.embeds, connection: c, settings: w.settings.current }, w.prep)).toEqual({ ok: false, reason: 'public-url' });
		}
	});

	it('rechecks the template (it may come from a sync) and rejects unknown variables', async () => {
		const w = await world();
		const parsed = parseEmbeds('![[a.png]]');
		if (!parsed.ok) throw new Error();
		const c = { ...w.settings.current.connections[0]!, keyTemplate: 'k/{nope}' };
		expect(await prepareJob({ notePath: 'n.md', snapshot: '', embeds: parsed.embeds, connection: c, settings: w.settings.current }, w.prep)).toEqual({ ok: false, reason: 'template', detail: 'unknown-variable' });
		expect(w.reads).toEqual([]);
	});

	it('over maxFileMB is skipped without reading; over maxJobMB the rest waits for the next run', async () => {
		const w = await world();
		w.files.set('img/big.png', new Uint8Array(21 * 1024 * 1024));
		const p = await plan(w, '![[big.png]]');
		expect(p.skipped).toEqual([{ offset: 0, original: '![[big.png]]', reason: 'too-large' }]);
		expect(w.reads).toEqual([]);

		await w.settings.mutate((d) => {
			d.upload.maxJobMB = (PNG_A.length + PNG_B.length - 1) / (1024 * 1024);
			return { ok: true, value: undefined };
		});
		const q = await plan(w, '![[a.png]] ![[b.png]] ![[a.png]]');
		expect(q.groups.map((g) => g.files[0]!.sourcePath)).toEqual(['img/a.png']);
		expect(q.deferred.map((g) => g.files[0]!.sourcePath)).toEqual(['img/b.png']);
	});
});

describe('runJob (10-1 steps 6 to 8)', () => {
	it('sends each group once, replaces every occurrence in the closed note, and removes the records', async () => {
		const note = 'a ![[a.png]] b ![[a copy.png|図]] c ![[a.png]]\n';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(w.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect(r.files.map((f) => [f.sourcePath, f.outcome, f.linked])).toEqual([
			['img/a.png', 'delivered', true],
			['img/a copy.png', 'delivered', true],
		]);
		expect(r.link).toEqual({ kind: 'applied', apply: { applied: true, via: 'file', verified: true } });
		expect(w.disk.text).toBe('a ![a](s3-bridge://work/k/a.png) b ![図](s3-bridge://work/k/a.png) c ![a](s3-bridge://work/k/a.png)\n');
		expect(w.pending.items).toEqual([]);
		// I1 for both sources and the bytes sent.
		expect(w.settings.current.privateFiles).toEqual(expect.arrayContaining([sha256Hex(PNG_A)]));
		expect(w.settings.current.history).toHaveLength(2);
	});

	it('open note: one editor transaction; edited meanwhile: nothing replaced, Markdown copied instead', async () => {
		const note = '![[a.png]] and ![[b.png]]';
		const w = await world([priv, pub], note);
		const ed = new FakeEditor(note);
		w.editors.push(ed);
		const r = await runJob(await plan(w, note), confirm(w, priv), w.run);
		expect(r.link).toMatchObject({ kind: 'applied', apply: { via: 'editor' } });
		expect(ed.transactions).toBe(1);
		expect(ed.value).toBe('![a](s3-bridge://work/k/a.png) and ![b](s3-bridge://work/k/b.png)');

		const v = await world([priv, pub], note);
		const typed = new FakeEditor(`${note}!`);
		v.editors.push(typed);
		const s = await runJob(await plan(v, note), confirm(v, priv), v.run);
		expect(s.link).toEqual({ kind: 'copied', ok: true, fallback: { applied: false, reason: 'changed' } });
		expect(typed.transactions).toBe(0);
		expect(v.copied).toEqual(['![a](s3-bridge://work/k/a.png)\n![b](s3-bridge://work/k/b.png)']);
		expect(v.pending.items).toEqual([]);
	});

	it('copy chosen: the note is not touched; a failed copy keeps the records as delivered', async () => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		const r = await runJob(await plan(w, note), confirm(w, priv, 'copy'), w.run);
		expect(r.link).toEqual({ kind: 'copied', ok: true });
		expect(w.disk.text).toBe(note);
		const v = await world([priv, pub], note);
		v.copyFails = true;
		const s = await runJob(await plan(v, note), confirm(v, priv, 'copy'), v.run);
		expect(s.link).toEqual({ kind: 'copied', ok: false });
		expect(s.files[0]).toMatchObject({ outcome: 'delivered', linked: false });
		expect(v.pending.items.map((i) => i.state)).toEqual(['delivered']);
	});

	it('the job’s own saves (I1, history) between groups do not stop it: the store generation is not compared', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		const gen = w.settings.generation;
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(w.settings.generation).toBeGreaterThan(gen);
		expect(r.files.map((f) => f.outcome)).toEqual(['delivered', 'delivered']);
		expect(w.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png', 'head:k/b.png', 'put:k/b.png']);
	});

	const changes: [string, StorageConnection, (w: World) => Promise<void>, string, string][] = [
		// The job's subscription notices the change at the first save or checkpoint and aborts.
		['connection changed after confirming', priv, async (w) => void (await w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], { ...priv, region: 'us-east-1' }, 'p'))), 'stopped', 'aborted'],
		['public connection changed after confirming', pub, async (w) => void (await w.settings.mutate(saveConnectionOp(w.settings.current.connections[1], { ...pub, region: 'us-east-1' }, 'p'))), 'stopped', 'connection-changed'],
		['profile changed (auth generation)', priv, async (w) => void (await w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], priv, 'other'))), 'stopped', 'auth-changed'],
		['public profile changed', pub, async (w) => void (await w.settings.mutate(saveConnectionOp(w.settings.current.connections[1], pub, 'other'))), 'stopped', 'auth-changed'],
		// Private: I1 cannot be saved first, so the file leaves the group before any check.
		['data.json became unreadable (private)', priv, (w) => Promise.resolve(void (w.storeIO.disk = undefined)), 'excluded', 'private-not-saved'],
		['data.json became unreadable (public)', pub, (w) => Promise.resolve(void (w.storeIO.disk = undefined)), 'stopped', 'read-only'],
	];
	it.each(changes)('%s: no request is started', async (_, connection, change, outcome, reason) => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note, connection);
		const c = confirm(w, connection);
		await change(w);
		const r = await runJob(p, c, w.run);
		expect(w.s3.calls).toEqual([]);
		expect(r.files[0]).toMatchObject({ outcome, reason, linked: false });
		expect(w.disk.text).toBe(note);
		if (reason === 'aborted') expect(r.aborted).toBe('connection-changed');
	});

	it('a profile change while a Put is in flight aborts it (record kept as uncertain) and later groups are not started', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		w.s3.on('put', (_key, signal) => {
			void w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], priv, 'other'));
			return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
		});
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(r.aborted).toBe('auth-changed');
		// The Put is unknown; the one recovery Head is refused because the job is aborted: stopped, still uncertain (6-6).
		expect(r.files.map((f) => [f.sourcePath, f.outcome, f.reason])).toEqual([
			['img/a.png', 'stopped', 'aborted'],
			['img/b.png', 'not-started', undefined],
		]);
		expect(w.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect(w.pending.items.map((i) => [i.sourcePath, i.state, i.uncertain, i.putSent])).toEqual([['img/a.png', 'stopped', true, true]]);
		expect(w.disk.text).toBe(note);
	});

	it('the stop button aborts too; delivered files before it are still linked (10-4)', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		let puts = 0;
		w.s3.on('put', (key) => {
			puts++;
			w.s3.objects.set(key, checksumOf(sha256Hex(PNG_A)));
			w.abort.abort();
			return {};
		});
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(puts).toBe(1);
		expect(r.aborted).toBe('stop');
		expect(r.files.map((f) => [f.outcome, f.linked])).toEqual([
			['delivered', true],
			['not-started', false],
		]);
		expect(w.disk.text).toBe('![a](s3-bridge://work/k/a.png) ![[b.png]]');
	});

	it('a source changed after the upload gets no link and stays unresolved (10-2)', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		w.s3.on('put', (key) => {
			w.s3.objects.set(key, checksumOf(sha256Hex(PNG_A)));
			w.changed.add('img/a.png');
			return {};
		});
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(r.files.map((f) => [f.sourcePath, f.outcome, f.reason, f.linked])).toEqual([
			['img/a.png', 'unresolved', 'changed', false],
			['img/b.png', 'delivered', undefined, true],
		]);
		expect(w.disk.text).toBe('![[a.png]] ![b](s3-bridge://work/k/b.png)');
		expect(w.pending.items.map((i) => [i.sourcePath, i.state])).toEqual([['img/a.png', 'unresolved']]);
	});

	it('a modify event before the Put leaves the file out without sending (bytes unchanged)', async () => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		w.s3.on('head', () => {
			w.changed.add('img/a.png');
			return Promise.reject(sdkError(404, 'NotFound'));
		});
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(w.s3.ops()).toEqual(['head:k/a.png']);
		expect(r.files[0]).toMatchObject({ outcome: 'excluded', reason: 'changed', linked: false });
	});

	it('a source whose bytes changed without an event is caught by the rehash before linking', async () => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note);
		w.s3.on('put', (key) => {
			w.s3.objects.set(key, checksumOf(sha256Hex(PNG_A)));
			w.files.set('img/a.png', PNG_B);
			return {};
		});
		const r = await runJob(p, confirm(w, priv), w.run);
		expect(r.files[0]).toMatchObject({ outcome: 'unresolved', reason: 'changed', linked: false });
	});

	it('public: I2 is checked again right before the link, for a reused object too', async () => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		const p = await plan(w, note, pub);
		// The object already exists (reused, no Put); the source gets recorded as private meanwhile.
		w.s3.objects.set(p.groups[0]!.key, checksumOf(p.groups[0]!.sentSha256));
		w.s3.on('head', (key) => {
			void w.settings.mutate(addPrivateFilesOp([sha256Hex(PNG_A)]));
			return { ChecksumSHA256: w.s3.objects.get(key), ChecksumType: 'FULL_OBJECT' };
		});
		const r = await runJob(p, confirm(w, pub), w.run);
		expect(w.s3.ops()).toEqual([`head:${p.groups[0]!.key}`]);
		expect(r.files[0]).toMatchObject({ outcome: 'unresolved', reason: 'private-recorded', linked: false });
		expect(w.disk.text).toBe(note);
		expect(w.copied).toEqual([]);
	});

	it('a collision moves to the alternate key, and the links use the final key', async () => {
		const note = '![[a.png]]';
		const w = await world([priv, pub], note);
		w.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		const r = await runJob(await plan(w, note), confirm(w, priv), w.run);
		const alt = `k/a-${sha256Hex(PNG_A).slice(0, 8)}.png`;
		expect(r.files[0]).toMatchObject({ outcome: 'delivered', key: alt, linked: true });
		expect(w.disk.text).toBe(`![a](s3-bridge://work/${alt})`);
	});

	it('credentials are resolved before each group; if the gate fails nothing is recorded or sent', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		w.credentialsFail = true;
		const r = await runJob(await plan(w, note), confirm(w, priv), w.run);
		expect(r.files.map((f) => [f.outcome, f.reason])).toEqual([
			['not-started', 'credentials'],
			['not-started', 'credentials'],
		]);
		expect(w.s3.calls).toEqual([]);
		expect(w.pendingIO.writes).toBe(0);
		expect(r.link).toEqual({ kind: 'none' });
	});

	it('failed and stopped files get no link; their embeds stay', async () => {
		const note = '![[a.png]] ![[b.png]]';
		const w = await world([priv, pub], note);
		w.s3.on('put', () => Promise.reject(sdkError(403, 'AccessDenied')));
		const r = await runJob(await plan(w, note), confirm(w, priv), w.run);
		expect(r.files.map((f) => [f.outcome, f.linked])).toEqual([
			['failed', false],
			['delivered', true],
		]);
		expect(w.disk.text).toBe('![[a.png]] ![b](s3-bridge://work/k/b.png)');
	});
});

describe('excluded folders (8-1)', () => {
	it.each([
		['templates/a.md', ['templates'], true],
		['templates/sub/a.md', ['/templates/'], true],
		['templates2/a.md', ['templates'], false],
		['notes/a.md', ['templates', ''], false],
		['a.md', [], false],
	] as const)('%s in %j → %s', (path, folders, expected) => {
		expect(inExcludedFolder(path, folders)).toBe(expected);
	});
});

describe('uploadCommand (10-1)', () => {
	const command = (w: World, over: Partial<CommandDeps> = {}, note = '![[a.png]]') => {
		const calls: string[] = [];
		const deps: CommandDeps = {
			lock: new JobLock(),
			pending: w.pending,
			settings: w.settings,
			notePath: 'n.md',
			pickConnection: () => Promise.resolve(w.settings.current.connections[0]),
			detect: () => {
				const p = parseEmbeds(note);
				if (!p.ok) throw new Error();
				return Promise.resolve({ ok: true, snapshot: note, embeds: p.embeds });
			},
			prepare: w.prep,
			authGeneration: (id) => profileOf(w.settings.device, id)?.generation,
			confirm: (_plan, preview) => {
				calls.push(preview ? 'confirm:preview' : 'confirm');
				return Promise.resolve('replace');
			},
			run: (plan, confirmed) => {
				calls.push('run');
				return runJob(plan, confirmed, w.run);
			},
			...over,
		};
		return { deps, calls };
	};

	it('preview never sends nor writes records, and does not need the record file', async () => {
		const w = await world([priv, pub], '![[a.png]]');
		const { deps, calls } = command(w, { pending: { status: 'damaged' } });
		const r = await uploadCommand(deps, true);
		expect(r).toMatchObject({ stop: 'preview' });
		expect(calls).toEqual(['confirm:preview']);
		expect(w.s3.calls).toEqual([]);
		expect(w.pendingIO.writes).toBe(0);
	});

	it('upload: stops unless the record file is ready', async () => {
		const w = await world();
		const { deps, calls } = command(w, { pending: { status: 'damaged' } });
		expect(await uploadCommand(deps, false)).toEqual({ stop: 'pending-not-ready' });
		expect(calls).toEqual([]);
	});

	it('one job at a time; the lock is released afterwards, also after an error', async () => {
		const w = await world([priv, pub], '![[a.png]]');
		const { deps } = command(w);
		const release = deps.lock.acquire()!;
		expect(await uploadCommand(deps, false)).toEqual({ stop: 'busy' });
		release();
		expect(await uploadCommand(deps, false)).toMatchObject({ done: { link: { kind: 'applied' } } });
		expect(deps.lock.busy).toBe(false);
		const failing = command(w, { detect: () => Promise.reject(new Error('x')) }).deps;
		await expect(uploadCommand(failing, false)).rejects.toThrow();
		expect(failing.lock.busy).toBe(false);
	});

	it('a note in an excluded folder is not uploaded from, nor previewed', async () => {
		const w = await world([priv, pub], '![[a.png]]');
		await w.settings.mutate((d) => {
			d.upload.excludeFolders = ['n'];
			return { ok: true, value: undefined };
		});
		const { deps, calls } = command(w, { notePath: 'n/x.md' });
		expect(await uploadCommand(deps, false)).toEqual({ stop: 'excluded-folder' });
		expect(await uploadCommand(deps, true)).toEqual({ stop: 'excluded-folder' });
		expect(calls).toEqual([]);
		expect(w.reads).toEqual([]);
	});

	it('cancel on the confirmation screen sends nothing', async () => {
		const w = await world();
		const { deps, calls } = command(w, { confirm: () => Promise.resolve(undefined) });
		expect(await uploadCommand(deps, false)).toMatchObject({ stop: 'cancelled' });
		expect(calls).toEqual([]);
		expect(w.s3.calls).toEqual([]);
	});

	it('a connection that is not active is not used (I4)', async () => {
		const w = await world();
		// Recording the public target as private blocks the public connection.
		await w.settings.mutate((d) => {
			d.privateBuckets.push('aws:example-public');
			return { ok: true, value: undefined };
		});
		const { deps } = command(w, { pickConnection: () => Promise.resolve(w.settings.current.connections.find((c) => c.id === 'c2')) });
		expect(await uploadCommand(deps, false)).toEqual({ stop: 'connection-not-active' });
	});

	it('a connection changed between the screen and the first request stops it', async () => {
		const w = await world([priv, pub], '![[a.png]]');
		const { deps } = command(w, {
			confirm: async () => {
				await w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], { ...priv, region: 'us-west-2' }, 'p'));
				return 'replace';
			},
		});
		const r = await uploadCommand(deps, false);
		expect(r).toMatchObject({ done: { files: [{ outcome: 'stopped', reason: 'aborted' }], aborted: 'connection-changed' } });
		expect(w.s3.calls).toEqual([]);
	});
});

describe('resumableGroups (7-4)', () => {
	it('groups by groupId and never includes delivered items or their group', async () => {
		const { storedItem } = await import('./fixtures/pendingItems');
		const items = [
			storedItem('a', { groupId: 'g1', state: 'putting' }),
			storedItem('b', { groupId: 'g2', state: 'delivered' }),
			storedItem('c', { groupId: 'g1', state: 'putting' }),
			storedItem('d', { groupId: 'g2', state: 'done-unrecorded' }),
			storedItem('e', { groupId: 'g3', state: 'stopped' }),
		];
		expect(resumableGroups(items)).toEqual([['a', 'c'], ['e']]);
	});
});

// --- resuming, copying (7-4) -----------------------------------------------------

/** A job stopped by the stop button while its Put was in flight: the record stays as stopped and uncertain. */
async function stoppedJob(w: World, note = '![[a.png]]', connection: StorageConnection = priv) {
	const p = await plan(w, note, connection);
	w.s3.on('put', (_key, signal) => {
		w.abort.abort();
		return Promise.reject(Object.assign(new Error('aborted'), { name: signal?.aborted ? 'AbortError' : 'Unexpected' }));
	});
	await runJob(p, confirm(w, connection), w.run);
	w.s3.calls.length = 0;
	return p;
}

const resumeDeps = (w: World, signal = new AbortController().signal): ResumeDeps => ({ ...w.run, signal, encoder: w.encoder });
const resumeCmd = (w: World, answer = true, lock = new JobLock()) => {
	const shown: string[][][] = [];
	return {
		shown,
		run: () =>
			resumeCommand({
				lock,
				pending: w.pending,
				settings: w.settings,
				authGeneration: w.run.authGeneration,
				confirm: (targets) => {
					shown.push(targets.map((t) => t.groups.flat()));
					return Promise.resolve(answer);
				},
				run: (t, c) => resumeJob(t, c, resumeDeps(w)),
			}),
	};
};
const NOTE = 'notes/日報.md';
const copyDeps = (w: World, lock = new JobLock()) => ({ lock, pending: w.pending, settings: w.settings, copy: w.run.copy });

describe('resume (7-4, 6-5)', () => {
	it('confirms, then Heads the recorded key and re-sends the rebuilt bytes; the record ends delivered, waiting for the copy', async () => {
		const w = await world([priv, pub], '![[a.png]]');
		await stoppedJob(w);
		expect(w.pending.items.map((i) => [i.state, i.uncertain])).toEqual([['stopped', true]]);
		const cmd = resumeCmd(w);
		const r = await cmd.run();
		expect(cmd.shown).toEqual([[[w.pending.items[0]!.id]]]);
		expect(w.s3.ops()).toEqual(['head:k/a.png', 'put:k/a.png']);
		expect('done' in r && r.done[0]!.results.map((x) => x.outcome)).toEqual(['delivered']);
		expect(w.pending.items.map((i) => i.state)).toEqual(['delivered']);
		// Not applied to the note (no snapshot, D7); copying the Markdown removes the record.
		expect(w.disk.text).toBe('![[a.png]]');
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ copied: 1, ok: true, skipped: [] });
		expect(w.copied).toEqual(['![a](s3-bridge://work/k/a.png)']);
		expect(w.pending.items).toEqual([]);
	});

	it('cancelled on the screen: nothing is requested; another operation holding the lock: not even shown', async () => {
		const w = await world();
		await stoppedJob(w);
		expect(await resumeCmd(w, false).run()).toEqual({ stop: 'cancelled' });
		const lock = new JobLock();
		const release = lock.acquire()!;
		const busy = resumeCmd(w, true, lock);
		expect(await busy.run()).toEqual({ stop: 'busy' });
		expect(busy.shown).toEqual([]);
		release();
		expect(w.s3.calls).toEqual([]);
		expect(w.pending.items.map((i) => i.state)).toEqual(['stopped']);
	});

	it('a source changed since the record is not re-sent: unresolved', async () => {
		const w = await world();
		await stoppedJob(w);
		w.files.set('img/a.png', PNG_B);
		await resumeCmd(w).run();
		expect(w.s3.ops()).toEqual(['head:k/a.png']);
		expect(w.pending.items.map((i) => i.state)).toEqual(['unresolved']);
	});

	it('the object arrived after all: found by Head, nothing re-sent', async () => {
		const w = await world();
		await stoppedJob(w);
		w.s3.objects.set('k/a.png', checksumOf(sha256Hex(PNG_A)));
		await resumeCmd(w).run();
		expect(w.s3.ops()).toEqual(['head:k/a.png']);
		expect(w.pending.items.map((i) => i.state)).toEqual(['delivered']);
	});

	it('the recorded storage no longer matches the connection: not shown, not requested (6-5 step 0)', async () => {
		const w = await world();
		await stoppedJob(w);
		await w.settings.mutate(deleteConnectionOp(priv.id));
		expect(resumeTargets(w.pending.items, w.settings.current)).toEqual({ ready: [], mismatched: [[w.pending.items[0]!.id]] });
		const cmd = resumeCmd(w);
		expect(await cmd.run()).toEqual({ stop: 'nothing', mismatched: 1 });
		expect(cmd.shown).toEqual([]);
		expect(w.s3.calls).toEqual([]);
	});

	it('resumeTargets: a record of another storage, classification or a mixed group is not resumed', async () => {
		const { storedItem } = await import('./fixtures/pendingItems');
		const w = await world();
		const ok = { connectionId: priv.id, target: 'aws:example-private' as const, classification: 'private' as const };
		const items = [
			storedItem('a', { ...ok, groupId: 'g1' }),
			storedItem('b', { ...ok, groupId: 'g2', target: 'aws:elsewhere' }),
			storedItem('c', { ...ok, groupId: 'g3', classification: 'public' }),
			storedItem('d', { ...ok, groupId: 'g4' }),
			storedItem('e', { ...ok, groupId: 'g4', target: 'aws:elsewhere' }),
		];
		const r = resumeTargets(items, w.settings.current);
		expect(r.ready.map((t) => [t.connection.id, t.groups])).toEqual([[priv.id, [['a']]]]);
		expect(r.mismatched).toEqual([['b'], ['c'], ['d', 'e']]);
	});

	it('bytes made by another converter version are not re-sent: unresolved, no Put', async () => {
		const w = await world();
		await stoppedJob(w, '![[a.png]]', pub);
		const other: Encoder = { electronVersion: '39.0.0', decode: () => w.encoder.decode() };
		const target = resumeTargets(w.pending.items, w.settings.current).ready[0]!;
		const c = w.settings.current.connections.find((x) => x.id === pub.id)!;
		await resumeJob(target, confirmedValues(c, profileOf(w.settings.device, pub.id)?.generation, 'replace'), { ...resumeDeps(w), encoder: other });
		expect(w.s3.ops()).toEqual([`head:${w.pending.items[0]!.key}`]);
		expect(w.pending.items.map((i) => i.state)).toEqual(['unresolved']);
	});

	it('a profile change during the resume aborts the Put in flight and leaves the record uncertain', async () => {
		const w = await world();
		await stoppedJob(w);
		w.s3.on('put', (_key, signal) => {
			void w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], priv, 'other'));
			return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
		});
		const r = await resumeCmd(w).run();
		expect('done' in r && r.done[0]!.aborted).toBe('auth-changed');
		// Recover mode keeps the unknown outcome as it is (6-6), for a later resume.
		expect(w.pending.items.map((i) => [i.state, i.uncertain])).toEqual([['indeterminate', true]]);
	});

	it('a connection changed between the screen and the first request stops it', async () => {
		const w = await world();
		await stoppedJob(w);
		const r = await resumeCommand({
			lock: new JobLock(),
			pending: w.pending,
			settings: w.settings,
			authGeneration: w.run.authGeneration,
			confirm: async () => {
				await w.settings.mutate(saveConnectionOp(w.settings.current.connections[0], { ...priv, region: 'us-east-1' }, 'p'));
				return true;
			},
			run: (t, c) => resumeJob(t, c, resumeDeps(w)),
		});
		expect('done' in r && r.done[0]!.results.map((x) => x.outcome)).toEqual(['stopped']);
		expect(w.s3.calls).toEqual([]);
	});

	it('credentials that fail the gate: nothing requested, the record is kept', async () => {
		const w = await world();
		await stoppedJob(w);
		w.credentialsFail = true;
		const r = await resumeCmd(w).run();
		expect('done' in r && r.done[0]!.results).toEqual([{ id: w.pending.items[0]!.id, outcome: 'stopped', reason: 'credentials' }]);
		expect(w.s3.calls).toEqual([]);
		expect(w.pending.items.map((i) => i.state)).toEqual(['stopped']);
	});
});

describe('copyDelivered (7-4)', () => {
	async function deliveredJob(w: World, connection: StorageConnection, note = '![[a.png]]') {
		w.copyFails = true;
		await runJob(await plan(w, note, connection), confirm(w, connection, 'copy'), w.run);
		w.copyFails = false;
		expect(w.pending.items.map((i) => i.state)).toEqual(['delivered']);
	}

	it('public: uses the connection’s base URL as it is now; a failed copy keeps the record', async () => {
		const w = await world();
		await deliveredJob(w, pub);
		const key = w.pending.items[0]!.key;
		await w.settings.mutate(saveConnectionOp(w.settings.current.connections[1], { ...pub, publicBaseUrl: 'https://img.example.com' }, 'p'));
		w.copyFails = true;
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ copied: 0, ok: false, skipped: [] });
		expect(w.pending.items).toHaveLength(1);
		w.copyFails = false;
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ copied: 1, ok: true, skipped: [] });
		expect(w.copied).toEqual([`![](https://img.example.com/${key})`]);
		expect(w.pending.items).toEqual([]);
	});

	it('public: content recorded as private since is not linked (I2) and becomes unresolved', async () => {
		const w = await world();
		await deliveredJob(w, pub);
		await w.settings.mutate(addPrivateFilesOp([sha256Hex(PNG_A)]));
		const id = w.pending.items[0]!.id;
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ copied: 0, ok: true, skipped: [{ id, reason: 'private-recorded' }] });
		expect(w.copied).toEqual([]);
		expect(w.pending.items.map((i) => [i.state, i.reason])).toEqual([['unresolved', 'private-recorded']]);
	});

	it('a connection that no longer points to the recorded storage is not linked', async () => {
		const w = await world();
		await deliveredJob(w, priv);
		await w.settings.mutate(deleteConnectionOp(priv.id));
		const id = w.pending.items[0]!.id;
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ copied: 0, ok: true, skipped: [{ id, reason: 'target-mismatch' }] });
		expect(w.pending.items).toHaveLength(1);
	});

	it('a file moved to the alternate key is linked at that key', async () => {
		const w = await world();
		w.s3.objects.set('k/a.png', checksumOf('0'.repeat(64)));
		await deliveredJob(w, priv);
		await copyDelivered(copyDeps(w), NOTE);
		expect(w.copied).toEqual([`![a](s3-bridge://work/k/a-${sha256Hex(PNG_A).slice(0, 8)}.png)`]);
	});

	it('copies the records of one note only; the others stay', async () => {
		const w = await world();
		await deliveredJob(w, priv);
		expect(await copyDelivered(copyDeps(w), 'notes/other.md')).toEqual({ stop: 'nothing' });
		expect(w.pending.items).toHaveLength(1);
		expect(await copyDelivered(copyDeps(w), NOTE)).toMatchObject({ copied: 1 });
	});

	it('takes the lock; nothing delivered: nothing to do', async () => {
		const w = await world();
		expect(await copyDelivered(copyDeps(w), NOTE)).toEqual({ stop: 'nothing' });
		const lock = new JobLock();
		lock.acquire();
		expect(await copyDelivered(copyDeps(w, lock), NOTE)).toEqual({ stop: 'busy' });
	});

	it('keeps the table form of an occurrence and the size', async () => {
		const w = await world();
		await deliveredJob(w, priv, '| x |\n|---|\n| ![[a.png\\|300]] |');
		await copyDelivered(copyDeps(w), NOTE);
		expect(w.copied).toEqual(['![a\\|300](s3-bridge://work/k/a.png)']);
	});
});
