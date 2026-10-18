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
	it.each(['embeds', 'embeds-v1', 'embeds-v1-fenced', 'embeds-2', 'embeds-crlf'])('%s: the same embeds, offsets, strings and table membership as the cache', (name) => {
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

	it('leaves out what the cache leaves out: URLs with a scheme, HTML blocks, tab-indented code', () => {
		const own = parsed(note('embeds-2'));
		expect(own.some((e) => /\]\((https?|s3-bridge):/.test(e.original))).toBe(false);
		expect(own.some((e) => e.original.includes('html-details') || e.original.includes('tab-indented-code'))).toBe(false);
		// …and keeps what it keeps, even though an upload will not rewrite all of them.
		for (const kept of ['"タイトル")', '#見出し]]', '^abc]]', '|説明|300]]', '![[置換検証]]', '![[double-backslash.png]]', '![[in-link.png]]', '![[after-code-percent.png]]']) {
			expect(own.some((e) => e.original.includes(kept)), kept).toBe(true);
		}
	});

	it('tables as measured: not right after a paragraph line, and rows need a |', () => {
		const own = parsed(note('embeds-2'));
		const flag = (name: string) => own.find((e) => e.original.includes(name))!;
		expect(flag('table-after-paragraph').inTable).toBe(false);
		expect(flag('table-row.png').inTable).toBe(true);
		expect(flag('table-lazy-row').inTable).toBe(false);
		expect(flag('table-no-pipe').inTable).toBe(true);
	});

	it('flags tables in a quote, callout or list (the cache cannot tell whether they are tables)', () => {
		const own = parsed(note('embeds-2'));
		expect(own.filter((e) => e.inNestedTable).map((e) => e.original)).toEqual(['![[quote-table.png]]', '![[callout-table.png]]']);
		expect(parsed('- item\n\n  | a | b |\n  |---|---|\n  | ![[x.png]] | y |\n').map((e) => e.inNestedTable)).toEqual([true]);
		// No delimiter row, no table: a sized image in a callout is not flagged.
		expect(parsed('> [!note]\n> ![[a.png|300]]\n').map((e) => e.inNestedTable)).toEqual([false]);
		expect(parsed('> a | b ![[x.png]]\n').map((e) => e.inNestedTable)).toEqual([false]);
	});

	it('a heading line does not stop a table from starting', () => {
		expect(parsed('## 表\n| a | b |\n|---|---|\n| ![[x.png]] | y |\n').map((e) => e.inTable)).toEqual([true]);
	});

	it('after ATX and setext headings a table starts; after a paragraph it does not (measured)', () => {
		const text = [
			'# t',
			'',
			'## h2',
			'| a | b |',
			'|---|---|',
			'| ![[x.png\\|100]] | h2 |',
			'',
			'### h3',
			'| c | d |',
			'| --- | --- |',
			'| ![[x.png]] | h3 |',
			'',
			'setext',
			'---',
			'| e | f |',
			'|---|---|',
			'| ![[x.png\\|200]] | setext |',
			'',
			'paragraph',
			'| g | h |',
			'|---|---|',
			'| ![[x.png\\|300]] | paragraph |',
			'',
		].join('\n');
		expect(parsed(text).map((e) => e.inTable)).toEqual([true, true, true, false]);
		// The cache reported tables at lines 3-5, 8-10 and 14-16, and lines 18-21 as one paragraph.
		const p = parseEmbeds(text);
		if (!p.ok) throw new Error();
		const embeds = p.embeds.map(({ offset, original }) => ({ offset, original }));
		const tables = [3, 8, 14].map((startLine) => ({ startLine, endLine: startLine + 2 }));
		expect(compareWithCache(text, p.embeds, { embeds, tables, comments: [] })).toBeUndefined();
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

	it.each(['embeds', 'embeds-v1', 'embeds-v1-fenced', 'embeds-2'])('%s', (name) => {
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
		expect(parsed('# t\r\n\r\n![[a.png]]\r\n')).toEqual([{ offset: 7, original: '![[a.png]]', inComment: false, inTable: false, inNestedTable: false }]);
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
		// e.g. a cell of a table in a list or callout, which the parser does not see as a table
		['![t\\|200](a.png)', false, 'escaped-pipe'],
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

	it('a line just turned into a code fence of the same length, with the cache still from before: aborted', async () => {
		// The measured pair: embeds-v1-fenced.md is embeds-v1.md with "@@@" changed to a fence, and its cache is the new one.
		const fenced = note('embeds-v1-fenced');
		expect(await detectEmbeds(source([fenced], [cacheOf('embeds-v1')]))).toMatchObject({ ok: false, reason: 'mismatch' });
		expect(await detectEmbeds(source([fenced], [cacheOf('embeds-v1-fenced')]))).toMatchObject({ ok: true });
	});

	it('a note without a cache entry yet is a mismatch unless it has no embeds', async () => {
		expect(await detectEmbeds(source(['# empty\n'], [undefined]))).toMatchObject({ ok: true, embeds: [] });
		expect(await detectEmbeds(source([text], [undefined]))).toMatchObject({ ok: false, reason: 'mismatch' });
	});
});
