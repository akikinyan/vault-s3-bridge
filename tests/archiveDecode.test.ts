import { describe, expect, it } from 'vitest';
import { htmlDecode, jsonStrings, jsonUnescape, markdownUnescape, NameMatcher, nameForms, percentDecode, searchForms } from '../src/archive/decode';
import { archivedPathOf, isSafeVaultPath, parseMarker, restoredPathOf } from '../src/archive/paths';

/** Whether `name` is found in `text` (as a scanned file would be searched). */
function found(text: string, name: string, parsed?: string): boolean {
	const m = new NameMatcher([['id', name]]);
	const out = new Set<string>();
	for (const form of searchForms(text, parsed)) m.find(form, out);
	return out.has('id');
}

describe('decodings (8-3)', () => {
	it('% as UTF-8, repeated for double encoding, invalid runs kept', () => {
		expect(percentDecode('a%20b%2Epdf')).toBe('a b.pdf');
		expect(percentDecode('a%2520b.pdf')).toBe('a b.pdf');
		expect(percentDecode('%E6%97%A5%E6%9C%AC')).toBe('日本');
		expect(percentDecode('%E6%97x %FF %C0%AF %zz')).toBe('%E6%97x %FF %C0%AF %zz');
		expect(percentDecode('%FF%41')).toBe('%FFA');
	});

	it('JSON escapes without parsing, surrogate pairs joined, an escaped backslash kept apart', () => {
		expect(jsonUnescape('a\\u0020b \\"q\\" \\/ \\ud83d\\ude00')).toBe('a b "q" / 😀');
		expect(jsonUnescape('\\\\u0041')).toBe('\\u0041');
		expect(jsonUnescape('bad \\x and \\u12')).toBe('bad \\x and \\u12');
	});

	it('HTML references, named ones included; Markdown escapes', () => {
		expect(htmlDecode('a&#32;b&#x2E;pdf &eacute; &amp;')).toBe('a b.pdf é &');
		expect(markdownUnescape('a\\_b.pdf \\[x\\] \\日')).toBe('a_b.pdf [x] \\日');
	});
});

describe('a name is found in every way a text can write it (8-3, design 13)', () => {
	it.each([
		['JSON escapes and % (as a Canvas stores it)', '{"nodes":[{"file":"a\\u0020b%2Epdf"}]}', 'a b.pdf'],
		['JSON that is not valid JSON', '{"x": "a\\u0020b.pdf",}\n{"y": 1}', 'a b.pdf'],
		['HTML reference and %', '<a href="a&#32;b%2Epdf">', 'a b.pdf'],
		['double % encoding', '[t](a%2520b.pdf)', 'a b.pdf'],
		['Markdown escape', '[[a\\_b.pdf]]', 'a_b.pdf'],
		['NFD dakuten in the text', '[[が.pdf]]'.normalize('NFD'), 'が.pdf'],
		['NFD dakuten in the name', '[[が.pdf]]', 'が.pdf'.normalize('NFD')],
		['upper case extension', '[[Report.PDF]]', 'report.pdf'],
		['a name written %-encoded', '[[a%2Epdf]]', 'a%2Epdf'],
		['HTML then Markdown escape', '&#91;a\\_b.pdf&#93;', 'a_b.pdf'],
	])('%s', (_label, text, name) => {
		expect(found(text, name)).toBe(true);
	});

	it('a Canvas is searched in its parsed strings too', () => {
		const canvas = '{"nodes":[{"text":"see a\\u0020b%2Epdf"}]}';
		expect(found(canvas, 'a b.pdf', jsonStrings(canvas))).toBe(true);
		expect(() => jsonStrings('{"nodes": [')).toThrow();
	});

	it('other names are not found; a part of a longer name still counts', () => {
		expect(found('[[ab.pdf]]', 'b.pdf')).toBe(true);
		expect(found('[[a.pdfx]]', 'a.pdf')).toBe(true);
		expect(found('[[a.png]]', 'a.pdf')).toBe(false);
		expect(found('nothing here', 'LICENSE')).toBe(false);
		expect(found('see LICENSE file', 'LICENSE')).toBe(true);
	});

	it('the name forms are N(name) and N(P(name))', () => {
		expect(nameForms('A%20B.PDF')).toEqual(['a%20b.pdf', 'a b.pdf']);
	});
});

describe('NameMatcher finds exactly what includes finds', () => {
	// A small seeded generator, so a failure can be replayed.
	function rng(seed: number) {
		return () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
	}
	const pieces = ['a', 'b', 'ab', 'x.tar', '.gz', '.pdf', '.PDF', 'が'.normalize('NFD'), 'が', ' ', '%2E', '%2520', '.', 'pdf', 'ba', '[[', ']]', '\\', '&#46;', '\\u002e'];

	it('on random names and texts', () => {
		const next = rng(42);
		const pick = () => pieces[Math.floor(next() * pieces.length)]!;
		const word = (n: number) => Array.from({ length: 1 + Math.floor(next() * n) }, pick).join('');
		for (let round = 0; round < 500; round++) {
			const names = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i) => [`id${i}`, word(4)] as const);
			const text = word(30);
			const m = new NameMatcher(names);
			for (const form of searchForms(text)) {
				const got = new Set<string>();
				m.find(form, got);
				const expected = new Set(names.filter(([, n]) => nameForms(n).some((f) => form.includes(f))).map(([id]) => id));
				expect([...got].sort(), `round ${round}: ${JSON.stringify({ names, form })}`).toEqual([...expected].sort());
			}
		}
	});

	it('suffixes, overlaps, and matches at both ends', () => {
		const m = new NameMatcher([
			['a', 'a.pdf'],
			['ba', 'ba.pdf'],
			['tgz', 'x.tar.gz'],
		]);
		const got = new Set<string>();
		m.find('ba.pdf', got);
		expect([...got].sort()).toEqual(['a', 'ba']);
		const end = new Set<string>();
		m.find('x.tar.gz', end);
		expect([...end]).toEqual(['tgz']);
	});
});

describe('archive paths and marker (8-1, 8-7, 8-8)', () => {
	it('only a marker of version 1 is taken on', () => {
		expect(parseMarker('{"format":"vault-s3-bridge-archive","version":1}')).toBe('valid');
		expect(parseMarker('{"format":"vault-s3-bridge-archive","version":2}')).toBe('newer');
		for (const bad of [undefined, '', '{', '[]', '{"format":"x","version":1}', '{"format":"vault-s3-bridge-archive","version":"1"}', '{"format":"vault-s3-bridge-archive","version":0}']) {
			expect(parseMarker(bad), String(bad)).toBe('invalid');
		}
	});

	it('paths stay inside the vault and the archive', () => {
		expect(archivedPathOf('a/b.pdf')).toBe('_s3-archive/a/b.pdf');
		expect(restoredPathOf('_s3-archive/a/b.pdf')).toBe('a/b.pdf');
		for (const bad of ['', '/a.pdf', 'a/../b.pdf', './a.pdf', 'a//b.pdf', 'a\u0000.pdf', 'a\\b.pdf']) expect(isSafeVaultPath(bad), bad).toBe(false);
		expect(archivedPathOf('_s3-archive/x.pdf')).toBeUndefined();
		expect(restoredPathOf('_s3-archive/.vault-s3-bridge-archive.json')).toBeUndefined();
		expect(restoredPathOf('_s3-archive/_s3-archive/x.pdf')).toBeUndefined();
		expect(restoredPathOf('other/x.pdf')).toBeUndefined();
	});
});
