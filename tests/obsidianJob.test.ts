// The Obsidian glue of the upload job, with stand-ins for the parts of the app it touches.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownView, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { detectSource, noteAccess, resolveLink, saveOpenEditors } from '../src/upload/obsidianJob';

/** A stand-in built on the class's prototype, so instanceof holds; the glue only uses the given members. */
const stub = <T>(proto: object, members: object): T => Object.assign(Object.create(proto) as object, members) as T;
const file = stub<TFile>(TFile.prototype, { path: 'notes/n.md', basename: 'n', stat: { size: 1 } });

/** One open view of the note whose save() writes the editor text to the disk (unless told otherwise). */
function appWith(disk: { text: string }, editorText: string, save: 'writes' | 'fails' | 'does-nothing' = 'writes') {
	const saves: number[] = [];
	const view = stub<MarkdownView>(MarkdownView.prototype, {
		file,
		editor: { getValue: () => editorText },
		save: () => {
			saves.push(1);
			if (save === 'fails') return Promise.reject(new Error('cannot save'));
			if (save === 'writes') disk.text = editorText;
			return Promise.resolve();
		},
	});
	const app = {
		workspace: { getLeavesOfType: () => [{ view }] },
		vault: { read: () => Promise.resolve(disk.text) },
	} as unknown as App;
	return { app, saves };
}

describe('saveOpenEditors (8-1 step 2, D1)', () => {
	it('saves unsaved text first, then the editor and the disk agree', async () => {
		const disk = { text: 'old' };
		const { app, saves } = appWith(disk, 'old typed');
		expect(await saveOpenEditors(app, file)).toBe(true);
		expect(saves).toHaveLength(1);
		expect(disk.text).toBe('old typed');
	});

	it('does not save when only the line endings differ', async () => {
		const { app, saves } = appWith({ text: 'a\r\nb\r\n' }, 'a\nb\n');
		expect(await saveOpenEditors(app, file)).toBe(true);
		expect(saves).toEqual([]);
	});

	it('the save fails, or the disk still differs afterwards: false (detection stops)', async () => {
		expect(await saveOpenEditors(appWith({ text: 'old' }, 'new', 'fails').app, file)).toBe(false);
		expect(await saveOpenEditors(appWith({ text: 'old' }, 'new', 'does-nothing').app, file)).toBe(false);
	});
});

describe('resolveLink (8-4)', () => {
	it('resolves from the note’s own path and returns the file in the vault', async () => {
		const calls: [string, string][] = [];
		const target = { path: 'img/a.png', basename: 'a', stat: { size: 3 } };
		const app = {
			metadataCache: {
				getFirstLinkpathDest: (linkpath: string, from: string) => {
					calls.push([linkpath, from]);
					return linkpath === 'a.png' ? target : null;
				},
			},
			vault: { readBinary: () => Promise.resolve(new Uint8Array([1, 2, 3]).buffer) },
		} as unknown as App;
		const found = resolveLink(app, 'notes/n.md', 'a.png');
		expect(found).toMatchObject({ path: 'img/a.png', basename: 'a', size: 3 });
		expect(await found!.read()).toEqual(new Uint8Array([1, 2, 3]));
		expect(resolveLink(app, 'notes/n.md', 'missing.png')).toBeUndefined();
		expect(calls).toEqual([
			['a.png', 'notes/n.md'],
			['missing.png', 'notes/n.md'],
		]);
	});
});

describe('detectSource().waitForChange (8-3)', () => {
	let listener: ((f: unknown) => void) | undefined;
	const offrefs: unknown[] = [];
	const app = {
		metadataCache: {
			on: (_: string, cb: (f: unknown) => void) => {
				listener = cb;
				return 'ref';
			},
			offref: (ref: unknown) => offrefs.push(ref),
		},
	} as unknown as App;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', globalThis);
		offrefs.length = 0;
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('moves on after the time limit when no change event comes', async () => {
		let done = false;
		const waiting = detectSource(app, file).waitForChange(3000).then(() => (done = true));
		await vi.advanceTimersByTimeAsync(2999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await waiting;
		expect(offrefs).toEqual(['ref']);
	});

	it('returns as soon as this note’s cache changes, and ignores other notes', async () => {
		let done = false;
		const waiting = detectSource(app, file).waitForChange(3000).then(() => (done = true));
		listener?.({ path: 'other.md' });
		await vi.advanceTimersByTimeAsync(0);
		expect(done).toBe(false);
		listener?.(file);
		await waiting;
		expect(offrefs).toEqual(['ref']);
	});
});

describe('noteAccess().identity (Phase 5 Step 1: a renamed note keeps its TFile)', () => {
	const make = () => stub<TFile>(TFile.prototype, { path: 'notes/a.md', basename: 'a', stat: { size: 1 } });
	const appOf = (files: Map<string, TFile>) =>
		({ workspace: { getLeavesOfType: () => [] }, vault: { getFileByPath: (p: string) => files.get(p) ?? null } }) as unknown as App;

	it('the same file at the same path', () => {
		const f = make();
		expect(noteAccess(appOf(new Map([['notes/a.md', f]])), f).identity()).toBe('same');
	});

	it('renamed or moved: the same TFile at another path', () => {
		const f = make();
		const files = new Map([['notes/a.md', f]]);
		const note = noteAccess(appOf(files), f);
		files.delete('notes/a.md');
		f.path = 'other/b.md';
		files.set('other/b.md', f);
		expect(note.identity()).toBe('moved');
	});

	it('renamed and back again is the same place (the batch job keeps its own record of renames)', () => {
		const f = make();
		const files = new Map([['notes/a.md', f]]);
		const note = noteAccess(appOf(files), f);
		f.path = 'notes/x.md';
		f.path = 'notes/a.md';
		expect(note.identity()).toBe('same');
	});

	it('deleted', () => {
		const f = make();
		const files = new Map([['notes/a.md', f]]);
		const note = noteAccess(appOf(files), f);
		files.delete('notes/a.md');
		expect(note.identity()).toBe('deleted');
	});

	it('made again at the same path: another TFile there', () => {
		const f = make();
		const files = new Map([['notes/a.md', f]]);
		const note = noteAccess(appOf(files), f);
		files.set('notes/a.md', make());
		expect(note.identity()).toBe('deleted');
	});

	it('renamed and then deleted', () => {
		const f = make();
		const files = new Map([['notes/a.md', f]]);
		const note = noteAccess(appOf(files), f);
		files.delete('notes/a.md');
		f.path = 'other/b.md';
		expect(note.identity()).toBe('deleted');
	});
});
