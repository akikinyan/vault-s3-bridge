import fc from 'fast-check';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { checkKey, formatReference, parseReference, referenceMarkdown, safeAltText } from '../src/reference/reference';

const md = new MarkdownIt();
function renderedImages(markdown: string): { src: string; alt: string }[] {
	const html = md.render(markdown);
	return [...html.matchAll(/<img src="([^"]*)" alt="([^"]*)"/g)].map((m) => ({
		src: m[1]!.replace(/&amp;/g, '&'),
		alt: m[2]!.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
	}));
}

const SPECIAL_KEYS = [
	'images/png-blue.png',
	'images/日本語 フォルダ/画像 (1).jpg',
	"images/記号/a!b'c*d#e?f%g.gif",
	'a(b)c/[x]/y z.png',
	'emoji/😀.webp',
	'plus+and&amp;=.png',
];

describe('reference format and parse', () => {
	it.each(SPECIAL_KEYS)('round-trips %s', (key) => {
		const ref = formatReference('work', key);
		expect(ref).toMatch(/^s3-bridge:\/\/work\/[A-Za-z0-9\-_.~/%]+$/);
		expect(parseReference(ref)).toEqual({ ok: true, value: { alias: 'work', key } });
	});

	it('encodes characters that encodeURIComponent leaves alone', () => {
		expect(formatReference('work', "a(b)!'*")).toBe('s3-bridge://work/a%28b%29%21%27%2A');
	});

	it('round-trips arbitrary valid keys', () => {
		const segment = fc.string({ unit: 'binary', minLength: 1, maxLength: 20 }).filter((s) => s !== '.' && s !== '..' && !s.includes('/'));
		fc.assert(
			fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), (segments) => {
				const key = segments.join('/');
				fc.pre(checkKey(key) === undefined);
				const parsed = parseReference(formatReference('a1', key));
				return parsed.ok && parsed.value.key === key;
			}),
			{ numRuns: 500 },
		);
	});

	it('rejects invalid references without throwing', () => {
		expect(parseReference('https://example.com/a.png')).toEqual({ ok: false, reason: 'not-a-reference' });
		expect(parseReference('s3-bridge://Work/a.png')).toEqual({ ok: false, reason: 'invalid-alias' });
		expect(parseReference('s3-bridge:///a.png')).toEqual({ ok: false, reason: 'invalid-alias' });
		expect(parseReference('s3-bridge://work/%E0%A4%A')).toEqual({ ok: false, reason: 'invalid-encoding' });
		expect(parseReference('s3-bridge://work/')).toEqual({ ok: false, reason: 'invalid-key' });
		expect(parseReference('s3-bridge://work/a//b')).toEqual({ ok: false, reason: 'invalid-key' });
		expect(parseReference('s3-bridge://work/a/../b')).toEqual({ ok: false, reason: 'invalid-key' });
	});

	it('enforces the 1024-byte S3 key limit', () => {
		expect(checkKey('a'.repeat(1024))).toBeUndefined();
		expect(checkKey('a'.repeat(1025))).toBe('invalid-key');
		expect(checkKey('あ'.repeat(342))).toBe('invalid-key'); // 1026 bytes
		expect(() => formatReference('work', 'a'.repeat(1025))).toThrow('invalid-key');
	});
});

describe('generated Markdown', () => {
	it.each(SPECIAL_KEYS)('renders one image whose source parses back to %s', (key) => {
		const images = renderedImages(referenceMarkdown('work', key));
		expect(images).toHaveLength(1);
		const parsed = parseReference(images[0]!.src);
		expect(parsed.ok && parsed.value.key).toBe(key);
	});

	it.each([
		['line\nbreak.png', 'line break.png'],
		['ends-with-backslash\\', 'ends-with-backslash'],
		['bra]cket[s|pipe.png', 'brackets pipe.png'.replace(' ', '')],
		['`code`<tag>.png', 'codetag.png'],
		['   ', 'image'],
		['\u0000\u0007', 'image'],
	])('keeps the syntax intact for file name %j', (name, alt) => {
		const key = `dir/${name}`;
		if (checkKey(key)) return;
		const markdown = referenceMarkdown('work', key);
		expect(markdown.split('\n')).toHaveLength(1);
		const images = renderedImages(markdown);
		expect(images).toHaveLength(1);
		expect(images[0]!.alt).toBe(alt);
		const parsed = parseReference(images[0]!.src);
		expect(parsed.ok && parsed.value.key).toBe(key);
	});

	it('limits alt text length', () => {
		expect(safeAltText('x'.repeat(300))).toHaveLength(100);
	});
});
