import { describe, expect, it } from 'vitest';
import { parseEmbeds, parseEmbedSyntax, parseLinkSyntax } from '../src/upload/detect';
import { buildReference, escapeLinkText, markdownFor, outputShape, type ReferenceInput, type Target, unescapeLinkText, verifyMarkdown } from '../src/upload/rewrite';

const pub: Target = { classification: 'public', publicBaseUrl: 'https://cdn.example.com/' };
const priv: Target = { classification: 'private', alias: 'work' };

const embed = (original: string, inTable = false) => {
	const r = parseEmbedSyntax(original, inTable);
	if (!r.ok) throw new Error(r.reason);
	return { kind: 'embed' as const, syntax: r.value };
};
const link = (original: string, inTable = false) => {
	const r = parseLinkSyntax(original, inTable);
	if (!r.ok) throw new Error(r.reason);
	return { kind: 'link' as const, syntax: r.value };
};
const build = (source: ReferenceInput['source'], target: Target, over: Partial<ReferenceInput> = {}) =>
	buildReference({ source, format: 'pdf', target, key: 'k/x.pdf', fileName: 'x.pdf', fileBase: 'x', inTable: false, ...over });
const md = (r: ReturnType<typeof build>) => (r.ok ? r.markdown : r.reason);

describe('parseLinkSyntax (design 6-1)', () => {
	it.each([
		['[[x.pdf]]', false, { kind: 'wiki', path: 'x.pdf' }],
		['[[x.pdf|資料]]', false, { kind: 'wiki', path: 'x.pdf', text: '資料' }],
		['[[x.pdf|300]]', false, { kind: 'wiki', path: 'x.pdf', text: '300' }],
		['[[x.pdf\\|表]]', true, { kind: 'wiki', path: 'x.pdf', text: '表' }],
		['[t](x.pdf)', false, { kind: 'markdown', path: 'x.pdf', text: 't' }],
		['[t](<x y.pdf>)', false, { kind: 'markdown', path: 'x y.pdf', text: 't' }],
		['[*強調*](x.pdf)', false, { kind: 'markdown', path: 'x.pdf', text: '*強調*' }],
		['[a\\|b](x.pdf)', true, { kind: 'markdown', path: 'x.pdf', text: 'a\\|b' }],
	])('%s', (original, inTable, value) => {
		expect(parseLinkSyntax(original, inTable)).toEqual({ ok: true, value });
	});

	it.each([
		['[[x.pdf|a|b]]', false, 'multiple-pipes'],
		['[[x.pdf\\|表|別]]', true, 'unparsable'],
		['[[x.pdf#page=3]]', false, 'subpath'],
		['[[x.pdf#^b]]', false, 'subpath'],
		['[t](x.pdf#page=2)', false, 'subpath'],
		['[[x.pdf\\|a]]', false, 'escaped-pipe'],
		['[a\\|b](x.pdf)', false, 'escaped-pipe'],
		['[t](x.pdf "title")', false, 'title'],
		['[t](https://example.com/x.pdf)', false, 'external'],
		['[t](s3-bridge://work/k/x.pdf)', false, 'reference'],
		['[[]]', false, 'unparsable'],
	])('%s → %s', (original, inTable, reason) => {
		expect(parseLinkSyntax(original, inTable)).toEqual({ ok: false, reason });
	});
});

describe('outputShape (design 6-2)', () => {
	it('a link stays a link; an image embed stays an embed; another embed is a link only in public storage', () => {
		expect(outputShape('link', 'png', 'private')).toBe('link');
		expect(outputShape('embed', 'png', 'public')).toBe('embed');
		expect(outputShape('embed', 'pdf', 'public')).toBe('link');
		expect(outputShape('embed', 'pdf', 'private')).toBe('embed');
	});
});

describe('buildReference: the table of design 6-2', () => {
	it.each([
		['![[x.pdf]]', pub, '[x.pdf](https://cdn.example.com/k/x.pdf)'],
		['![[x.pdf]]', priv, '![x.pdf](s3-bridge://work/k/x.pdf)'],
		['![[x.pdf|300]]', priv, '![x.pdf|300](s3-bridge://work/k/x.pdf)'],
		['![[x.pdf|300]]', pub, '[x.pdf](https://cdn.example.com/k/x.pdf)'],
		['![[x.pdf|資料]]', pub, '[資料](https://cdn.example.com/k/x.pdf)'],
		['![t](x.pdf)', pub, '[t](https://cdn.example.com/k/x.pdf)'],
		['![t](x.pdf)', priv, '![t](s3-bridge://work/k/x.pdf)'],
	])('embed %s', (original, target, expected) => {
		expect(md(build(embed(original), target))).toBe(expected);
	});

	it.each([
		['[[x.pdf]]', pub, '[x.pdf](https://cdn.example.com/k/x.pdf)'],
		['[[x.pdf]]', priv, '[x.pdf](s3-bridge://work/k/x.pdf)'],
		['[[x.pdf|資料]]', pub, '[資料](https://cdn.example.com/k/x.pdf)'],
		['[[x.pdf|300]]', priv, '[300](s3-bridge://work/k/x.pdf)'],
		['[t](x.pdf)', pub, '[t](https://cdn.example.com/k/x.pdf)'],
		['[*強調*](x.pdf)', priv, '[*強調*](s3-bridge://work/k/x.pdf)'],
	])('link %s', (original, target, expected) => {
		expect(md(build(link(original), target))).toBe(expected);
	});

	it('a link to an image is a link; an image embed is Phase 3 output', () => {
		const png = { format: 'png' as const, key: 'k/a.png', fileName: 'a.png', fileBase: 'a' };
		expect(md(build(link('[[a.png]]'), pub, png))).toBe('[a.png](https://cdn.example.com/k/a.png)');
		expect(md(build(embed('![[a.png]]'), priv, png))).toBe('![a](s3-bridge://work/k/a.png)');
		expect(md(build(embed('![[a.png|300]]'), pub, png))).toBe('![|300](https://cdn.example.com/k/a.png)');
	});

	it('plain display text is escaped once and reads back as written; Markdown link text is kept', () => {
		const s = build(link('[[x.pdf|50% *off* <b> #1]]'), pub);
		expect(md(s)).toBe('[50\\% \\*off\\* \\<b\\> \\#1](https://cdn.example.com/k/x.pdf)');
		expect(s.ok && unescapeLinkText(s.parts.alt)).toBe('50% *off* <b> #1');
		expect(md(build(link('[[x.pdf]]'), pub, { fileName: 'a_b [1].pdf' }))).toBe('[a\\_b \\[1\\].pdf](https://cdn.example.com/k/x.pdf)');
	});

	it('in a table: the separator and the text keep their pipes escaped', () => {
		expect(md(build(link('[[x.pdf\\|a]]', true), pub, { inTable: true }))).toBe('[a](https://cdn.example.com/k/x.pdf)');
		expect(md(build(link('[a\\|b](x.pdf)', true), pub, { inTable: true }))).toBe('[a\\|b](https://cdn.example.com/k/x.pdf)');
		expect(md(build(embed('![[x.pdf\\|300]]', true), priv, { inTable: true }))).toBe('![x.pdf\\|300](s3-bridge://work/k/x.pdf)');
		expect(md(build(link('[[x.pdf]]', true), pub, { inTable: true, fileName: 'a|b.pdf' }))).toBe('[a\\|b.pdf](https://cdn.example.com/k/x.pdf)');
	});

	it('refuses what it cannot write faithfully', () => {
		// The alt of `![t](p)` already holds Markdown escapes: escaping it again would show the backslash.
		expect(md(build(embed('![a\\*b](x.pdf)'), pub))).toBe('escaped-text');
		// Text that makes another element inside the link.
		expect(md(build(link('[![i](a.png)](x.pdf)'), priv))).toBe('markdown-check');
		expect(md(build(link('[see [[n]]](x.pdf)'), priv))).toBe('markdown-check');
	});

	it('the record keeps the bracket text: rebuilding from it gives the same Markdown', () => {
		for (const [source, target, inTable] of [
			[embed('![[x.pdf|資料]]'), pub, false],
			[link('[[x.pdf|50% off]]'), pub, false],
			[link('[[x.pdf\\|a]]', true), priv, true],
			[embed('![[x.pdf\\|300]]', true), priv, true],
		] as const) {
			const r = build(source, target, { inTable });
			if (!r.ok) throw new Error(r.reason);
			expect(markdownFor(r.parts, target, 'k/x.pdf')).toBe(r.markdown);
		}
	});
});

describe('verifyMarkdown (design 6-3)', () => {
	it('reads generated Markdown with schemes counted, which detection does not', () => {
		const text = '[t](https://cdn.example.com/k/x.pdf)';
		const detected = parseEmbeds(text);
		expect(detected.ok && detected.links).toEqual([]);
		expect(verifyMarkdown(text, pub, 'k/x.pdf', { shape: 'link', inTable: false })).toBe(true);
	});

	it('the shape, a single element, the key and bare pipes in a table', () => {
		expect(verifyMarkdown('[t](https://cdn.example.com/k/x.pdf)', pub, 'k/x.pdf', { shape: 'embed', inTable: false })).toBe(false);
		expect(verifyMarkdown('![t](https://cdn.example.com/k/x.pdf)', pub, 'k/x.pdf', { shape: 'link', inTable: false })).toBe(false);
		expect(verifyMarkdown('[t](https://cdn.example.com/k/y.pdf)', pub, 'k/x.pdf', { shape: 'link', inTable: false })).toBe(false);
		expect(verifyMarkdown('[![a](https://cdn.example.com/a)](https://cdn.example.com/k/x.pdf)', pub, 'k/x.pdf', { shape: 'link', inTable: false })).toBe(false);
		expect(verifyMarkdown('[a|b](s3-bridge://work/k/x.pdf)', priv, 'k/x.pdf', { shape: 'link', inTable: true })).toBe(false);
		expect(verifyMarkdown('[a\\|b](s3-bridge://work/k/x.pdf)', priv, 'k/x.pdf', { shape: 'link', inTable: true })).toBe(true);
		expect(verifyMarkdown('[a\\\\|b](s3-bridge://work/k/x.pdf)', priv, 'k/x.pdf', { shape: 'link', inTable: true })).toBe(false);
	});

	it('escapeLinkText and unescapeLinkText', () => {
		const s = 'a\\b`c*d_e[f]g<h>i!j|k~l=m$n%o#p&q^r';
		expect(unescapeLinkText(escapeLinkText(s))).toBe(s);
		expect(escapeLinkText('a\tb\u0000c')).toBe('a b c');
	});
});
