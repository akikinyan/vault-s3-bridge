import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CacheView, compareWithCache, detectEmbeds, type DetectSource, lineOf, parseEmbeds, parseEmbedSyntax, parseSize } from '../src/upload/detect';

// Notes measured in Obsidian (Electron 43.7.7): the expected values are the real metadataCache output
// (embeds with offsets, sections by line), with same-length path renames applied to note and values alike.
const note = (name: string) => readFileSync(new URL(`./fixtures/notes/${name}.md`, import.meta.url), 'utf8');
const cacheOf = (name: string): CacheView => {
	const raw = JSON.parse(readFileSync(new URL(`./fixtures/notes/${name}.cache.json`, import.meta.url), 'utf8')) as {
		embeds: { offset: number; original: string }[];
		sections: { type: string; startLine: number; endLine: number }[];
	};
	return { embeds: raw.embeds, tables: raw.sections.filter((s) => s.type === 'table'), comments: raw.sections.filter((s) => s.type === 'comment') };
};
const parsed = (text: string) => {
	const r = parseEmbeds(text);
	if (!r.ok) throw new Error(`unparsable: ${r.problem}`);
	return r.embeds;
};

describe('parseEmbeds against measured metadataCache output', () => {
	it.each(['embeds', 'embeds-v1', 'embeds-v1-fenced'])('%s: the same embeds, offsets, strings and table membership as the cache', (name) => {
		const text = note(name);
		const cache = cacheOf(name);
		const own = parsed(text);
		expect(own.map(({ offset, original }) => ({ offset, original }))).toEqual(cache.embeds);
		expect(compareWithCache(text, own, cache)).toBeUndefined();
	});

	it('marks the %% comments the cache includes, and the embeds in the table', () => {
		const own = parsed(note('embeds'));
		expect(own.filter((e) => e.inComment).map((e) => e.offset)).toEqual([715, 755]);
		expect(own.filter((e) => e.inTable).map((e) => e.offset)).toEqual([233, 274]);
	});

	it('an unclosed fence (the measured 3b case) hides everything after it, as in the cache', () => {
		expect(parsed(note('embeds-v1-fenced')).map((e) => e.offset)).not.toContain(967);
		expect(parsed(note('embeds-v1')).map((e) => e.offset)).toContain(967);
	});
});

describe('the measured notes saved with CRLF', () => {
	// Obsidian reports cache offsets on the stored text (measured: a CRLF note gave 18 and 98 where LF gives
	// 15 and 89), so each offset moves by the number of line breaks before it; lines and sections stay.
	const crlf = (s: string) => s.replace(/\n/g, '\r\n');
	const shift = (lf: string, offset: number) => offset + (lf.slice(0, offset).match(/\n/g) ?? []).length;

	it.each(['embeds', 'embeds-v1', 'embeds-v1-fenced'])('%s', (name) => {
		const lf = note(name);
		const cache = cacheOf(name);
		const text = crlf(lf);
		const crlfCache: CacheView = { ...cache, embeds: cache.embeds.map((e) => ({ ...e, offset: shift(lf, e.offset) })) };
		const own = parsed(text);
		expect(own.map(({ offset, original }) => ({ offset, original }))).toEqual(crlfCache.embeds);
		expect(compareWithCache(text, own, crlfCache)).toBeUndefined();
		for (const e of own) expect(text.slice(e.offset, e.offset + e.original.length)).toBe(e.original);
	});
});

describe('compareWithCache', () => {
	const text = note('embeds');
	const own = parsed(text);
	const cache = cacheOf('embeds');

	it('reports embeds only one side has, a count difference, and table disagreements', () => {
		expect(compareWithCache(text, own, { ...cache, embeds: cache.embeds.slice(1) })).toEqual({ onlyOwn: [own[0] && { offset: own[0].offset, original: own[0].original }], onlyCache: [], table: [], comment: [] });
		const moved = cache.embeds.map((e, i) => (i === 0 ? { ...e, offset: e.offset + 1 } : e));
		expect(compareWithCache(text, own, { ...cache, embeds: moved })?.onlyCache).toHaveLength(1);
		// The cache's table ranges are stale (e.g. right after the row above became a delimiter row).
		expect(compareWithCache(text, own, { ...cache, tables: [] })?.table.map((e) => e.offset)).toEqual([233, 274]);
		expect(compareWithCache(text, [...own, own[0]!], cache)).toBeDefined(); // same set, different count
	});

	it('an embed in a cache comment section must be in a %% comment for the parser too', () => {
		// comment@41-43 is the %% block around ![[percent-block-ignored.png]] (offset 755).
		const flipped = own.map((e) => (e.offset === 755 ? { ...e, inComment: false } : e));
		expect(compareWithCache(text, flipped, cache)?.comment).toEqual([{ offset: 755, original: '![[percent-block-ignored.png]]' }]);
	});

	it('counts lines the same way for CRLF and LF', () => {
		expect(lineOf('a\r\nb\r\nc', 6)).toBe(2);
		expect(lineOf('a\nb\nc', 4)).toBe(2);
	});
});

describe('parseEmbeds: what it refuses to guess', () => {
	it.each([
		['lone-cr', 'a\rb ![[x.png]]'],
		['unclosed-percent', 'a %% ![[x.png]]'],
		['unclosed-html-comment', 'a <!-- ![[x.png]]'],
		['comment-spans-block', '%%\n```\n![[x.png]]\n```\n%%'],
	])('%s', (problem, text) => {
		expect(parseEmbeds(text)).toMatchObject({ ok: false, problem });
	});

	it('front matter is never searched (design 8-2), only when it opens the note and is closed', () => {
		expect(parsed('---\ncover: ![[fm.png]]\n---\n![[body.png]]\n').map((e) => e.original)).toEqual(['![[body.png]]']);
		expect(parsed('---\nnot closed ![[x.png]]\n').map((e) => e.original)).toEqual(['![[x.png]]']);
	});

	it('a line with | is a table row only after a header and a delimiter row with the same cell count', () => {
		expect(parsed('a | b\n![[x.png]] | c\n').map((e) => e.inTable)).toEqual([false]);
		expect(parsed('a | b\n---|---|---\n![[x.png]] | c\n').map((e) => e.inTable)).toEqual([false]);
		expect(parsed('a | b\n---|---\n![[x.png]] | c\n\n![[y.png]]\n').map((e) => e.inTable)).toEqual([true, false]);
	});

	it('keeps CRLF offsets as stored', () => {
		expect(parsed('# t\r\n\r\n![[a.png]]\r\n')).toEqual([{ offset: 7, original: '![[a.png]]', inComment: false, inTable: false }]);
	});
});

describe('parseEmbedSyntax (8-4)', () => {
	it.each([
		['![[a.png]]', false, { kind: 'wiki', path: 'a.png' }],
		['![[a.png|300]]', false, { kind: 'wiki', path: 'a.png', size: '300' }],
		['![[a.png|300x200]]', false, { kind: 'wiki', path: 'a.png', size: '300x200' }],
		['![[a.png|図の説明]]', false, { kind: 'wiki', path: 'a.png', alt: '図の説明' }],
		['![[dir/a.png\\|100]]', true, { kind: 'wiki', path: 'dir/a.png', size: '100' }],
		['![図](a.png)', false, { kind: 'markdown', path: 'a.png', alt: '図' }],
		['![図|300x200](a.png)', false, { kind: 'markdown', path: 'a.png', alt: '図', size: '300x200' }],
		['![図|大きい](a.png)', false, { kind: 'markdown', path: 'a.png', alt: '図|大きい' }],
		['![](a%20b.png)', false, { kind: 'markdown', path: 'a%20b.png', alt: '' }],
		['![空白 名](<dir/空白 名.gif>)', false, { kind: 'markdown', path: 'dir/空白 名.gif', alt: '空白 名' }],
		['![p](dir/a(1).png)', false, { kind: 'markdown', path: 'dir/a(1).png', alt: 'p' }],
		['![t\\|200](a.png)', true, { kind: 'markdown', path: 'a.png', alt: 't', size: '200' }],
	])('%s (table: %s)', (original, inTable, value) => {
		expect(parseEmbedSyntax(original, inTable)).toEqual({ ok: true, value });
	});

	it.each([
		['![[a.png|b|300]]', false, 'multiple-pipes'],
		['![[a.png#見出し]]', false, 'subpath'],
		['![[a.png^abc]]', false, 'subpath'],
		['![[a.png\\|300]]', false, 'escaped-pipe'],
		['![t](a.png "タイトル")', false, 'title'],
		['![](https://example.com/a.png)', false, 'external'],
		['![[https://example.com/a.png]]', false, 'external'],
		['![x](s3-bridge://demo/k/a.png)', false, 'reference'],
		['![x]()', false, 'unparsable'],
	])('%s is not a target: %s', (original, inTable, reason) => {
		expect(parseEmbedSyntax(original, inTable)).toEqual({ ok: false, reason });
	});

	it('sizes are W or WxH with each value 1 to 10000', () => {
		expect(['1', '10000', '300x200', '1x1'].map(parseSize)).toEqual(['1', '10000', '300x200', '1x1']);
		expect(['0', '10001', '300x0', 'x200', '300X200', '-1', '30 0'].map(parseSize)).toEqual(Array(7).fill(undefined));
	});
});

describe('detectEmbeds (8-3)', () => {
	const text = note('embeds');
	const good = cacheOf('embeds');
	const stale: CacheView = { ...good, embeds: good.embeds.slice(0, -1) };

	function source(reads: string[], caches: (CacheView | undefined)[], waits: number[] = []): DetectSource {
		let r = 0;
		let c = 0;
		return {
			read: () => Promise.resolve(reads[Math.min(r++, reads.length - 1)]!),
			cache: () => caches[Math.min(c++, caches.length - 1)],
			waitForChange: (ms) => {
				waits.push(ms);
				return Promise.resolve(); // no event: the caller must still move on
			},
		};
	}

	it('accepts a cache that matches at once, without waiting', async () => {
		const waits: number[] = [];
		expect(await detectEmbeds(source([text], [good], waits))).toMatchObject({ ok: true, snapshot: text });
		expect(waits).toEqual([]);
	});

	it('waits at most 3 s for a stale cache, re-reads, and accepts it once it matches', async () => {
		const waits: number[] = [];
		expect(await detectEmbeds(source([text], [stale, good], waits))).toMatchObject({ ok: true });
		expect(waits).toEqual([3000]);
	});

	it('aborts with the differing items when the cache still does not match', async () => {
		const r = await detectEmbeds(source([text], [stale]));
		expect(r).toMatchObject({ ok: false, reason: 'mismatch', mismatch: { onlyOwn: [{ offset: 1111 }] } });
	});

	it('restarts once with the new text when the disk changed meanwhile, then gives up', async () => {
		const edited = `${text}\n![[late.png]]\n`;
		const lateCache: CacheView = { ...good, embeds: [...good.embeds, { offset: text.length + 1, original: '![[late.png]]' }] };
		expect(await detectEmbeds(source([text, edited, edited], [stale, lateCache]))).toMatchObject({ ok: true, snapshot: edited });
		expect(await detectEmbeds(source([text, edited, `${edited}x`], [stale]))).toEqual({ ok: false, reason: 'changed' });
	});

	it('a note without a cache entry yet is a mismatch unless it has no embeds', async () => {
		expect(await detectEmbeds(source(['# empty\n'], [undefined]))).toMatchObject({ ok: true, embeds: [] });
		expect(await detectEmbeds(source([text], [undefined]))).toMatchObject({ ok: false, reason: 'mismatch' });
	});
});
