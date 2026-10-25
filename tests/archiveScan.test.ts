import { describe, expect, it } from 'vitest';
import { pathKey } from '../src/archive/paths';
import { type ArchiveFs, MAX_TEXT_BYTES, scanReferences, ScanIncomplete, sha256Hex } from '../src/archive/scan';
import { memoryFs, UNREADABLE } from './fixtures/archiveFs';

/** The configuration folder of the test vault (its name is set by the user). */
const CONFIG = '.config';
const names = (...paths: string[]) => paths.map((p) => [pathKey(p), p.slice(p.lastIndexOf('/') + 1)] as const);
const scan = (fs: ArchiveFs, candidates: readonly (readonly [string, string])[], editors: { path: string; text: string }[] = []) =>
	scanReferences({ fs, configDir: CONFIG, names: candidates, editors });

describe('scanReferences (8-3)', () => {
	it('finds references in notes everywhere: dot folders, .trash, HTML, Canvas, unknown text kinds', async () => {
		const { fs } = memoryFs({
			'n.md': '![[a.pdf]]',
			'.hidden/note.md': '[[b.pdf]]',
			'.trash/old.md': '[t](c%20c.pdf)',
			'page.html': '<img src="d&#46;png">',
			'board.canvas': '{"nodes":[{"type":"file","file":"att/e\\u0020e.pdf"}]}',
			'notes/.refs.md': 'f.pdf',
			'LIST': 'g.zip mentioned without extension of its own',
			'att/a.pdf': new Uint8Array([1]),
			'att/b.pdf': new Uint8Array([1]),
			'att/c c.pdf': new Uint8Array([1]),
			'att/d.png': new Uint8Array([1]),
			'att/e e.pdf': new Uint8Array([1]),
			'att/f.pdf': new Uint8Array([1]),
			'att/g.zip': new Uint8Array([1]),
			'att/h.pdf': new Uint8Array([1]),
		});
		const r = await scan(fs, names('att/a.pdf', 'att/b.pdf', 'att/c c.pdf', 'att/d.png', 'att/e e.pdf', 'att/f.pdf', 'att/g.zip', 'att/h.pdf'));
		expect([...r.referenced].sort()).toEqual(['att/a.pdf', 'att/b.pdf', 'att/c c.pdf', 'att/d.png', 'att/e e.pdf', 'att/f.pdf', 'att/g.zip']);
	});

	it('the configuration folder, .git and the marker are neither searched nor recorded', async () => {
		const { fs, reads } = memoryFs({
			[`${CONFIG}/workspace.json`]: '{"lastOpenFiles":["a.pdf"]}',
			'.git/COMMIT_EDITMSG': 'a.pdf',
			'_s3-archive/.vault-s3-bridge-archive.json': '{"format":"vault-s3-bridge-archive","version":1,"note":"a.pdf"}',
			'a.pdf': new Uint8Array([1]),
		});
		const r = await scan(fs, names('a.pdf'));
		expect(r.referenced.size).toBe(0);
		expect(reads).toEqual([]);
		expect([...r.snapshot.files.keys()]).toEqual(['a.pdf']);
		expect([...r.snapshot.folders]).toEqual(['_s3-archive']);
	});

	it('binary kinds are not read; an unknown kind is read whole only when its first bytes are text', async () => {
		const { fs, reads } = memoryFs({
			'movie.mp4': { size: 4e9 },
			'blob.bin': new Uint8Array([0x00, 0x01, 0x61, 0x2e, 0x70, 0x64, 0x66]),
			'notes.org': 'see a.pdf',
			'a.pdf': new Uint8Array([1]),
		});
		const r = await scan(fs, names('a.pdf'));
		expect(r.referenced.has('a.pdf')).toBe(true);
		expect(reads).toEqual(['notes.org']);
		expect(r.snapshot.files.get('movie.mp4')).toMatchObject({ kind: 'binary', size: 4e9 });
		expect(r.snapshot.files.get('blob.bin')).toMatchObject({ kind: 'sniffed' });
		expect(r.snapshot.files.get('notes.org')).toMatchObject({ kind: 'text', sha256: sha256Hex('see a.pdf') });
	});

	it('a note whose embeds the upload replaced does not keep the originals', async () => {
		const { fs } = memoryFs({
			'n.md': '![a](s3-bridge://work/att/a%20a.png)\n[[b.pdf]]',
			'board.canvas': '{"nodes":[{"type":"text","text":"![c](s3-bridge://work/att/c.png)"}]}',
			'att/a a.png': new Uint8Array([1]),
			'att/b.pdf': new Uint8Array([1]),
			'att/c.png': new Uint8Array([1]),
		});
		const r = await scan(fs, names('att/a a.png', 'att/b.pdf', 'att/c.png'));
		expect([...r.referenced]).toEqual(['att/b.pdf']);
	});

	it('a file never counts as naming itself', async () => {
		const { fs } = memoryFs({ 'list.txt': 'list.txt and other.txt', 'other.txt': 'x' });
		const r = await scan(fs, names('list.txt', 'other.txt'));
		expect([...r.referenced]).toEqual(['other.txt']);
	});

	it('open editors are searched and hashed (Markdown and Canvas)', async () => {
		const { fs } = memoryFs({ 'n.md': '', 'b.canvas': '{}', 'a.pdf': new Uint8Array([1]), 'c d.pdf': new Uint8Array([1]) });
		const r = await scan(fs, names('a.pdf', 'c d.pdf'), [
			{ path: 'n.md', text: 'typed [[a.pdf]]' },
			{ path: 'b.canvas', text: '{"nodes":[{"file":"c\\u0020d.pdf"}]}' },
		]);
		expect([...r.referenced].sort()).toEqual(['a.pdf', 'c d.pdf']);
		expect(r.snapshot.editors.get('n.md')).toBe(sha256Hex('typed [[a.pdf]]'));
	});

	it('the bytes are hashed, so a text that is not UTF-8 hashes the same when read again', async () => {
		const sjis = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x2c, 0x61, 0x2e, 0x70, 0x64, 0x66]); // "日本,a.pdf" in Shift_JIS
		const { fs } = memoryFs({ '.data/table.csv': sjis, 'a.pdf': new Uint8Array([1]) });
		const r = await scan(fs, names('a.pdf'));
		expect(r.referenced.has('a.pdf')).toBe(true);
		expect(r.snapshot.files.get('.data/table.csv')).toMatchObject({ sha256: sha256Hex(sjis), unwatched: true });
	});

	it('paths and candidate ids are compared as NFC', async () => {
		const nfd = 'が/note.md'.normalize('NFD');
		const { fs } = memoryFs({ [nfd]: '[[ぱ.pdf]]', ['ぱ.pdf'.normalize('NFD')]: new Uint8Array([1]) });
		const r = await scan(fs, names('ぱ.pdf'));
		expect([...r.referenced]).toEqual(['ぱ.pdf'.normalize('NFC')]);
		expect(r.snapshot.files.has('が/note.md')).toBe(true);
		expect(r.snapshot.files.get('が/note.md')?.path).toBe(nfd);
	});

	it.each([
		['a text over 20 MB', { 'big.md': { size: MAX_TEXT_BYTES + 1 } }, 'too-large', 'big.md'],
		['a text that cannot be read', { 'n.md': UNREADABLE }, 'unreadable', 'n.md'],
		['a Canvas that is not JSON', { 'b.canvas': '{"nodes": [' }, 'canvas', 'b.canvas'],
	])('stops on %s (I19)', async (_label, files, reason, path) => {
		const { fs } = memoryFs(files);
		const error = await scan(fs, names('a.pdf')).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ScanIncomplete);
		expect(error).toMatchObject({ reason, path });
	});

	it('stops when a folder cannot be listed', async () => {
		const { fs } = memoryFs({ 'd/n.md': '' }, ['d']);
		await expect(scan(fs, names('a.pdf'))).rejects.toMatchObject({ reason: 'unreadable', path: 'd' });
	});

	it('records every file in scope, marking what the vault does not report', async () => {
		const { fs } = memoryFs({ 'a.pdf': new Uint8Array([1]), '.trash/x.md': '', 'notes/.refs.md': '', 'notes/n.md': '' });
		const r = await scan(fs, []);
		expect(Object.fromEntries([...r.snapshot.files].map(([k, v]) => [k, v.unwatched]))).toEqual({ 'a.pdf': false, '.trash/x.md': true, 'notes/.refs.md': true, 'notes/n.md': false });
		expect([...r.snapshot.folders].sort()).toEqual(['.trash', 'notes']);
	});
});
