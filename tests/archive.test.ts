import { describe, expect, it } from 'vitest';
import { type ArchiveDeps, type ArchivePlan, archiveCommand, type ArchiveVault } from '../src/archive/archive';
import { ARCHIVE_MARKER, MARKER_CONTENT } from '../src/archive/paths';
import { archivedFiles, restoreFiles } from '../src/archive/restore';
import { sha256Hex } from '../src/archive/scan';
import { ChangeWatch } from '../src/archive/watch';
import { appendHistoryOp, saveConnectionOp } from '../src/settings/ops';
import { connectionTarget } from '../src/settings/registry';
import { SettingsStore } from '../src/settings/store';
import type { HistoryEntry, StorageConnection } from '../src/settings/types';
import { JobLock } from '../src/upload/job';
import { checksumOf } from '../src/upload/s3';
import { memoryFs } from './fixtures/archiveFs';
import { FakeS3, MemoryStoreIO, sdkError } from './fixtures/uploadFakes';

const CONFIG = '.config';
const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{filename}.{ext}' };
const bytes = (s: string) => new TextEncoder().encode(s);

let ids = 0;
function entry(content: Uint8Array, key: string, over: Partial<HistoryEntry> = {}): HistoryEntry {
	const sha = sha256Hex(content);
	return { id: `h${++ids}`, target: connectionTarget(priv), key, classification: 'private', sourceSha256: sha, sentSha256: sha, size: content.length, format: 'pdf', converter: 'none', at: '2026-10-20T00:00:00.000Z', ...over };
}

interface World {
	deps: ArchiveDeps;
	data: Map<string, unknown>;
	s3: FakeS3;
	watch: ChangeWatch;
	editors: { path: string; text: string }[];
	plans: ArchivePlan[];
	/** Called when the confirmation screen is shown; returns the paths chosen. */
	onConfirm: (plan: ArchivePlan) => readonly string[] | undefined;
	/** Called after each move (Obsidian events already delivered). */
	afterMove: (from: string, to: string) => void;
	vault: ArchiveVault;
	settings: SettingsStore;
	/** Folders made empty. */
	made: Set<string>;
}

async function world(files: Record<string, Uint8Array | string>, history: HistoryEntry[] = []): Promise<World> {
	const settings = new SettingsStore(new MemoryStoreIO([]));
	await settings.reload();
	expect((await settings.mutate(saveConnectionOp(undefined, priv, 'p'))).ok).toBe(true);
	if (history.length > 0) expect((await settings.mutate(appendHistoryOp(history))).ok).toBe(true);
	const s3 = new FakeS3([]);
	const m = memoryFs(files);
	const watch = new ChangeWatch();
	const read = (p: string) => m.data.get(p) as Uint8Array | undefined;
	const w = {
		data: m.data,
		s3,
		watch,
		editors: [] as { path: string; text: string }[],
		plans: [] as ArchivePlan[],
		onConfirm: (plan: ArchivePlan) => plan.candidates.map((c) => c.path),
		afterMove: () => undefined,
		settings,
		made: m.made,
	} as unknown as World;
	// What Obsidian would report for these operations: a folder created, a file renamed.
	const vault: ArchiveVault = {
		fs: m.fs,
		configDir: CONFIG,
		files: () =>
			[...m.data.entries()]
				.filter(([p, v]) => !p.split('/').some((s) => s.startsWith('.')) && v instanceof Uint8Array)
				.map(([p, v]) => ({ path: p, size: (v as Uint8Array).length })),
		editors: () => w.editors,
		indexed: () => ({ resolved: [], unresolved: [] }),
		hash: async (p) => {
			const b = read(p);
			return b ? sha256Hex(b) : undefined;
		},
		exists: async (p) => m.data.has(p) || m.folders().has(p),
		readMarker: async () => {
			const b = read(ARCHIVE_MARKER);
			return b ? new TextDecoder().decode(b) : undefined;
		},
		writeMarker: async () => {
			if (!m.data.has(ARCHIVE_MARKER)) m.data.set(ARCHIVE_MARKER, bytes(MARKER_CONTENT));
		},
		createFolder: async (p) => {
			m.made.add(p);
			watch.created(p);
		},
		rename: async (from, to) => {
			const b = m.data.get(from);
			if (!b) throw new Error('ENOENT');
			m.data.delete(from);
			m.data.set(to, b);
			watch.renamed(to, from);
			watch.modifiedPath(to);
			w.afterMove(from, to);
		},
	};
	w.vault = vault;
	w.deps = {
		lock: new JobLock(),
		settings,
		layoutReady: () => true,
		saveEditors: async () => true,
		watch: () => ({ watch, dispose: () => undefined }),
		vault,
		client: async () => s3 as never,
		timeoutMs: 1000,
		signal: new AbortController().signal,
		confirm: async (plan) => {
			w.plans.push(plan);
			return w.onConfirm(plan);
		},
	};
	return w;
}

const PDF_A = bytes('%PDF-a');
const PDF_B = bytes('%PDF-b');
const PDF_C = bytes('%PDF-c');

/** Three unreferenced, uploaded files, each on the storage. */
async function threeUploaded() {
	const h = [entry(PDF_A, 'k/a.pdf'), entry(PDF_B, 'k/b.pdf'), entry(PDF_C, 'k/c.pdf')];
	const w = await world({ 'n.md': 'no links', 'att/x/a.pdf': PDF_A, 'att/y/b.pdf': PDF_B, 'att/y/z/c.pdf': PDF_C }, h);
	for (const e of h) w.s3.objects.set(e.key, checksumOf(e.sentSha256));
	return w;
}

describe('archiveCommand (8-2 to 8-7)', () => {
	it('moves the chosen files into nested new folders, keeping their paths, with the marker; its own events never stop it', async () => {
		const w = await threeUploaded();
		const r = await archiveCommand(w.deps);
		expect(r).toEqual({ done: { moved: ['att/x/a.pdf', 'att/y/b.pdf', 'att/y/z/c.pdf'], notTried: [] } });
		expect([...w.data.keys()].filter((p) => p.endsWith('.pdf')).sort()).toEqual(['_s3-archive/att/x/a.pdf', '_s3-archive/att/y/b.pdf', '_s3-archive/att/y/z/c.pdf']);
		expect(new TextDecoder().decode(w.data.get(ARCHIVE_MARKER) as Uint8Array)).toBe(MARKER_CONTENT);
		expect(w.plans[0]!.candidates[0]).toMatchObject({ path: 'att/x/a.pdf', alias: 'work', key: 'k/a.pdf', converted: false });
		expect(w.s3.ops()).toEqual(['head:k/a.pdf', 'head:k/b.pdf', 'head:k/c.pdf']);
	});

	it('only the chosen files move; nothing chosen is a cancel', async () => {
		const w = await threeUploaded();
		w.onConfirm = () => ['att/y/b.pdf'];
		expect(await archiveCommand(w.deps)).toEqual({ done: { moved: ['att/y/b.pdf'], notTried: [] } });
		w.onConfirm = () => [];
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'cancelled' });
	});

	it('every reason a file is kept is counted (8-4, 8-5)', async () => {
		const files = {
			'n.md': '![[ref.pdf]]',
			'a/dup.pdf': PDF_A,
			'.trash/dup.pdf': PDF_A,
			'ref.pdf': PDF_B,
			'new.pdf': bytes('%PDF-never-sent'),
			'gone.pdf': PDF_C,
			'denied.pdf': bytes('%PDF-denied'),
			'big.png': new Uint8Array(21 * 1024 * 1024),
		};
		const h = [entry(PDF_A, 'k/dup.pdf'), entry(PDF_B, 'k/ref.pdf'), entry(PDF_C, 'k/gone.pdf'), entry(bytes('%PDF-denied'), 'k/denied.pdf')];
		const w = await world(files, h);
		w.s3.on('head', (key) => {
			throw sdkError(key === 'k/gone.pdf' ? 404 : 403, key === 'k/gone.pdf' ? 'NotFound' : 'Forbidden');
		});
		w.s3.on('head', (key) => {
			throw sdkError(key === 'k/gone.pdf' ? 404 : 403, key === 'k/gone.pdf' ? 'NotFound' : 'Forbidden');
		});
		const r = await archiveCommand(w.deps);
		expect(r).toEqual({ stop: 'nothing', excluded: { 'same-name': 1, referenced: 1, 'not-in-history': 1, 'not-on-storage': 1, unverified: 1, 'too-large': 1 } });
	});

	it('an object holding other bytes is not on the storage; a public image holds its converted bytes', async () => {
		const converted = entry(PDF_A, 'k/a.png', { sentSha256: sha256Hex(bytes('stripped')), format: 'png' });
		const w = await world({ 'a.png': PDF_A, 'b.pdf': PDF_B }, [converted, entry(PDF_B, 'k/b.pdf')]);
		w.s3.objects.set('k/a.png', checksumOf(converted.sentSha256));
		w.s3.objects.set('k/b.pdf', checksumOf(sha256Hex(bytes('other'))));
		w.onConfirm = () => undefined;
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'cancelled' });
		expect(w.plans[0]).toEqual({ candidates: [expect.objectContaining({ path: 'a.png', converted: true })], excluded: { 'not-on-storage': 1 } });
	});

	it('an expired SSO session stops the command: it is not "not on the storage"', async () => {
		const w = await threeUploaded();
		w.deps.client = async () => {
			throw Object.assign(new Error("Token is expired. To refresh this SSO session run 'aws sso login'"), { name: 'TokenProviderError' });
		};
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'auth', category: 'sso-login-required' });
	});

	it('an unsaved editor naming a file keeps it', async () => {
		const w = await threeUploaded();
		w.editors.push({ path: 'n.md', text: 'typed ![[b.pdf]]' });
		w.onConfirm = (plan) => {
			expect(plan.candidates.map((c) => c.path)).toEqual(['att/x/a.pdf', 'att/y/z/c.pdf']);
			return undefined;
		};
		await archiveCommand(w.deps);
		expect(w.plans).toHaveLength(1);
	});

	it.each([
		['the lock is held', (w: World) => void w.deps.lock.acquire(), { stop: 'busy' }],
		['the layout is not ready', (w: World) => void (w.deps.layoutReady = () => false), { stop: 'not-ready' }],
		['an editor cannot be saved', (w: World) => void (w.deps.saveEditors = async () => false), { stop: 'save-failed' }],
		['a folder of that name has no marker', (w: World) => void w.data.set('_s3-archive/x.md', bytes('')), { stop: 'foreign-folder' }],
		['the marker is of a later version', (w: World) => void w.data.set(ARCHIVE_MARKER, bytes('{"format":"vault-s3-bridge-archive","version":2}')), { stop: 'marker', state: 'newer' }],
		['the marker is broken', (w: World) => void w.data.set(ARCHIVE_MARKER, bytes('{')), { stop: 'marker', state: 'invalid' }],
		['a Canvas cannot be parsed', (w: World) => void w.data.set('b.canvas', bytes('{"nodes":[')), { stop: 'incomplete', reason: 'canvas', path: 'b.canvas' }],
	])('stops when %s', async (_label, arrange, expected) => {
		const w = await threeUploaded();
		arrange(w);
		expect(await archiveCommand(w.deps)).toEqual(expected);
		expect([...w.data.keys()].some((p) => p.startsWith('_s3-archive/att'))).toBe(false);
	});
});

describe('nothing moves once the vault changed (8-6, I20)', () => {
	it('a file added or renamed while the screen is open stops it (epoch)', async () => {
		const w = await threeUploaded();
		w.onConfirm = (plan) => {
			w.watch.created('new.md');
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'changed' });
	});

	it('a late modify with the same content does not stop it; changed content does', async () => {
		const w = await threeUploaded();
		w.onConfirm = (plan) => {
			w.watch.modifiedPath('n.md');
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toMatchObject({ done: { moved: ['att/x/a.pdf', 'att/y/b.pdf', 'att/y/z/c.pdf'] } });

		const v = await threeUploaded();
		v.onConfirm = (plan) => {
			v.data.set('n.md', bytes('now ![[a.pdf]]'));
			v.watch.modifiedPath('n.md');
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(v.deps)).toEqual({ stop: 'changed' });
	});

	it('a view changed in memory without any event (an unsaved Canvas) stops it', async () => {
		const w = await threeUploaded();
		w.data.set('b.canvas', bytes('{"nodes":[]}'));
		w.editors.push({ path: 'b.canvas', text: '{"nodes":[]}' });
		w.onConfirm = (plan) => {
			w.editors[0]!.text = '{"nodes":[{"type":"file","file":"att/x/a.pdf"}]}';
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'changed' });
	});

	it('a view opened after the scan on an unchanged file does not stop it', async () => {
		const w = await threeUploaded();
		w.onConfirm = (plan) => {
			w.editors.push({ path: 'n.md', text: 'no links' });
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toMatchObject({ done: { moved: ['att/x/a.pdf', 'att/y/b.pdf', 'att/y/z/c.pdf'] } });
	});

	it('typing into an open editor after the scan stops it', async () => {
		const w = await threeUploaded();
		w.editors.push({ path: 'n.md', text: 'no links' });
		w.onConfirm = (plan) => {
			w.editors[0]!.text = 'no links ![[a.pdf]]';
			w.watch.modifiedPath('n.md');
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'changed' });
	});

	it.each([
		['a note added to a dot folder', (w: World) => void w.data.set('.hidden/new.md', bytes('[[a.pdf]]'))],
		['a dot file in a normal folder changed with the same size', (w: World) => void w.data.set('notes/.refs.md', bytes('a.pdf'))],
		['a file of the same name added to .trash', (w: World) => void w.data.set('.trash/a.pdf', PDF_A)],
		['a watched file changed without an event', (w: World) => void w.data.set('n.md', bytes('changed, longer'))],
	])('before anything moves: %s (no event reaches the plugin)', async (_label, change) => {
		const w = await threeUploaded();
		w.data.set('notes/.refs.md', bytes('x.pdf'));
		w.onConfirm = (plan) => {
			change(w);
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toEqual({ stop: 'changed' });
	});

	it.each([
		['a note added to a dot folder', (w: World) => void w.data.set('.hidden/new.md', bytes('[[c.pdf]]'))],
		['a dot file in a normal folder changed', (w: World) => void w.data.set('notes/.refs.md', bytes('c.pdf'))],
		['a file of the same name added to .trash', (w: World) => void w.data.set('.trash/c.pdf', PDF_C)],
	])('between two moves: %s stops the rest, and what moved stays moved', async (_label, change) => {
		const w = await threeUploaded();
		w.data.set('notes/.refs.md', bytes('x.pdf'));
		w.afterMove = (from) => {
			if (from === 'att/x/a.pdf') change(w);
		};
		expect(await archiveCommand(w.deps)).toEqual({ done: { moved: ['att/x/a.pdf'], stopped: { path: 'att/y/b.pdf', reason: 'changed' }, notTried: ['att/y/z/c.pdf'] } });
		expect(w.data.has('_s3-archive/att/x/a.pdf')).toBe(true);
	});

	it('a source whose bytes changed after confirming is not moved', async () => {
		const w = await threeUploaded();
		w.onConfirm = (plan) => {
			w.data.set('att/y/b.pdf', bytes('%PDF-B'));
			w.watch.modifiedPath('att/y/b.pdf');
			return plan.candidates.map((c) => c.path);
		};
		expect(await archiveCommand(w.deps)).toEqual({ done: { moved: ['att/x/a.pdf'], stopped: { path: 'att/y/b.pdf', reason: 'source-changed' }, notTried: ['att/y/z/c.pdf'] } });
	});

	it('an occupied destination stops before moving', async () => {
		const w = await threeUploaded();
		w.afterMove = (from) => {
			if (from === 'att/x/a.pdf') w.data.set('_s3-archive/att/y/b.pdf', PDF_B);
		};
		expect(await archiveCommand(w.deps)).toMatchObject({ done: { moved: ['att/x/a.pdf'], stopped: { path: 'att/y/b.pdf' } } });
		expect(w.data.has('att/y/b.pdf')).toBe(true);
	});
});

describe('restoreFiles (8-8)', () => {
	async function archived() {
		const w = await threeUploaded();
		await archiveCommand(w.deps);
		return w;
	}

	it('lists archived files and moves them back, making folders as needed', async () => {
		const w = await archived();
		expect(archivedFiles(w.vault).map((f) => f.restoreTo)).toEqual(['att/x/a.pdf', 'att/y/b.pdf', 'att/y/z/c.pdf']);
		const r = await restoreFiles(new JobLock(), w.vault, ['_s3-archive/att/x/a.pdf']);
		expect(r).toEqual({ restored: ['_s3-archive/att/x/a.pdf'], skipped: [] });
		expect(w.data.has('att/x/a.pdf')).toBe(true);
	});

	it('never into an occupied path, nor when a file of the same name is outside the archive', async () => {
		const w = await archived();
		w.data.set('att/x/a.pdf', bytes('new'));
		w.data.set('elsewhere/b.pdf', bytes('namesake'));
		const r = await restoreFiles(new JobLock(), w.vault, ['_s3-archive/att/x/a.pdf', '_s3-archive/att/y/b.pdf', '_s3-archive/att/y/z/c.pdf']);
		expect(r).toEqual({
			restored: ['_s3-archive/att/y/z/c.pdf'],
			skipped: [
				{ path: '_s3-archive/att/x/a.pdf', reason: 'same-name' },
				{ path: '_s3-archive/att/y/b.pdf', reason: 'same-name' },
			],
		});
	});

	it('an occupied path with no namesake elsewhere is reported as occupied', async () => {
		const w = await archived();
		w.made.add('att/x/a.pdf');
		const r = await restoreFiles(new JobLock(), w.vault, ['_s3-archive/att/x/a.pdf']);
		expect(r).toEqual({ restored: [], skipped: [{ path: '_s3-archive/att/x/a.pdf', reason: 'occupied' }] });
	});

	it('works while settings are read-only, but not without a valid marker or while the lock is held', async () => {
		const w = await archived();
		const lock = new JobLock();
		const release = lock.acquire()!;
		expect(await restoreFiles(lock, w.vault, ['_s3-archive/att/x/a.pdf'])).toEqual({ stop: 'busy' });
		release();
		w.data.set(ARCHIVE_MARKER, bytes('{"format":"vault-s3-bridge-archive","version":9}'));
		expect(await restoreFiles(lock, w.vault, ['_s3-archive/att/x/a.pdf'])).toEqual({ stop: 'marker', state: 'newer' });
	});
});
