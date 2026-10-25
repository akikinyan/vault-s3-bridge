import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkKey } from '../src/reference/reference';
import { DEFAULT_KEY_TEMPLATE } from '../src/settings/types';
import {
	alternateKey,
	buildKey,
	checkTemplate,
	checkUploadKey,
	expandTemplate,
	identifyingVariables,
	keyValues,
	type KeyInput,
	type KeyVariable,
} from '../src/upload/key';

const SENT = '0123456789abcdef' + 'f'.repeat(48);
const SENT_1A = '1a2b3c4d' + '0'.repeat(56);
const input = (over: Partial<KeyInput> = {}): KeyInput => ({
	date: new Date(2026, 9, 16, 23, 59), // local time
	sourcePath: 'assets/x.png',
	notePath: 'notes/n.md',
	format: 'png',
	sentSha256: SENT,
	...over,
});
const values = (over: Partial<Record<KeyVariable, string>> = {}): Record<KeyVariable, string> => ({
	...keyValues(input()),
	...over,
});
const NFD_GA = 'が';

describe('buildKey: design examples (5-4)', () => {
	it('public default template', () => {
		expect(buildKey('attachments/{year}/{mon}/{hash}.{ext}', input())).toEqual({ ok: true, key: 'attachments/2026/10/0123456789abcdef.png' });
	});

	it('replaces slashes inside a value', () => {
		expect(expandTemplate('a/{notename}/{filename}.{ext}', values({ notename: '日報/10月', filename: '画像 (1)' }))).toEqual({ ok: true, key: 'a/日報_10月/画像 (1).png' });
	});

	it('rejects a .. segment instead of repairing it', () => {
		expect(expandTemplate('a/{filename}.{ext}', values({ filename: '..' }))).toEqual({ ok: true, key: 'a/...png' });
		expect(expandTemplate('a/{filename}', values({ filename: '..' }))).toEqual({ ok: false, reason: 'dot-segment' });
		expect(buildKey('a/{filename}', input({ sourcePath: 'assets/...png' }))).toEqual({ ok: false, reason: 'dot-segment' });
	});

	it('uses _ for the folder of a note at the vault root', () => {
		expect(buildKey('a/{foldername}/{filename}.{ext}', input({ notePath: 'top.md' }))).toEqual({ ok: true, key: 'a/_/x.png' });
		expect(buildKey('a/{foldername}/{notename}', input({ notePath: '日報/2026/10月.md' }))).toEqual({ ok: true, key: 'a/2026/10月' });
	});

	it('normalizes to NFC, in values and in the template', () => {
		const r = buildKey('{filename}.{ext}', input({ sourcePath: `${NFD_GA}.png` }));
		expect(r).toEqual({ ok: true, key: 'が.png' });
		expect(buildKey(`${NFD_GA}/{hash}`, input())).toEqual({ ok: true, key: 'が/0123456789abcdef' });
	});

	it('rejects an empty segment in the template', () => {
		expect(buildKey('a//{filename}.{ext}', input())).toEqual({ ok: false, reason: 'empty-segment' });
	});

	it('alternate keys', () => {
		expect(alternateKey('a/b/name.png', SENT_1A)).toEqual({ ok: true, key: 'a/b/name-1a2b3c4d.png' });
		expect(alternateKey('a/b/README', SENT_1A)).toEqual({ ok: true, key: 'a/b/README-1a2b3c4d' });
	});
});

describe('variable values', () => {
	it('pads month and day and maps jpeg to jpg', () => {
		expect(keyValues(input({ date: new Date(2026, 0, 5), format: 'jpeg', sourcePath: 'p/photo.final.JPG' }))).toEqual({
			year: '2026', mon: '01', day: '05', filename: 'photo.final', ext: 'jpg', notename: 'n', foldername: 'notes', hash: '0123456789abcdef',
		});
	});

	it('tidies: control characters removed, backslash replaced, spaces trimmed, empty becomes _', () => {
		expect(expandTemplate('{filename}', values({ filename: '  a\u0000b\u001fc\u007f\\d  ' }))).toEqual({ ok: true, key: 'abc_d' });
		expect(expandTemplate('x/{filename}', values({ filename: ' \u0007 ' }))).toEqual({ ok: true, key: 'x/_' });
		expect(expandTemplate('x/{filename}', values({ filename: '' }))).toEqual({ ok: true, key: 'x/_' });
	});

	it('keeps a leading-dot name whole', () => {
		expect(keyValues(input({ sourcePath: 'a/.hidden' })).filename).toBe('.hidden');
	});

	it('requires a SHA-256 hex digest', () => {
		expect(() => keyValues(input({ sentSha256: 'ABC' }))).toThrow();
		expect(() => alternateKey('a', 'xyz')).toThrow();
	});
});

describe('validation', () => {
	it('reports each structural error', () => {
		expect(checkUploadKey('/a')).toBe('leading-slash');
		expect(checkUploadKey('a/\u0001')).toBe('control-char');
		expect(checkUploadKey('a/')).toBe('empty-segment');
		expect(checkUploadKey('')).toBe('empty-segment');
		expect(checkUploadKey('a/./b')).toBe('dot-segment');
		expect(checkUploadKey('あ'.repeat(341) + 'a')).toBe(undefined); // 1024 bytes
		expect(checkUploadKey('あ'.repeat(341) + 'ab')).toBe('too-long');
		expect(checkUploadKey('a/b c/(1).png')).toBe(undefined);
	});

	it('validates the alternate key as well', () => {
		const long = 'a/' + 'b'.repeat(1018) + '.png'; // 1024 bytes
		expect(checkUploadKey(long)).toBe(undefined);
		expect(alternateKey(long, SENT_1A)).toEqual({ ok: false, reason: 'too-long' });
		expect(alternateKey('a/.png', SENT_1A)).toEqual({ ok: true, key: 'a/.png-1a2b3c4d' });
	});

	it('every key it builds can also be referenced (checkKey)', () => {
		const anyText = fc.string({ unit: fc.constantFrom('a', '.', '/', '\\', ' ', '\u0000', '\u007f', 'が', NFD_GA, '😀', '{', '}') , maxLength: 12 });
		fc.assert(
			fc.property(fc.constantFrom('{year}/{filename}.{ext}', 'x/{notename}/{foldername}/{filename}', '{filename}', DEFAULT_KEY_TEMPLATE.private), anyText, anyText, anyText, (template, f, n, d) => {
				const r = expandTemplate(template, values({ filename: f, notename: n, foldername: d }));
				if (!r.ok) return;
				expect(checkKey(r.key)).toBeUndefined();
				expect(checkUploadKey(r.key)).toBeUndefined();
				expect(r.key).toBe(r.key.normalize('NFC'));
				const alt = alternateKey(r.key, SENT_1A);
				if (alt.ok) expect(checkKey(alt.key)).toBeUndefined();
			}),
			{ numRuns: 500 },
		);
	});
});

describe('templates', () => {
	it('rejects unknown variables on save, and buildKey reports them as a result', () => {
		expect(checkTemplate('a/{foo}.{ext}')).toEqual({ reason: 'unknown-variable', name: 'foo' });
		expect(checkTemplate('a/{}.{ext}')).toEqual({ reason: 'unknown-variable', name: '' });
		// A template from synced or hand-edited settings never passed the save check.
		expect(buildKey('a/{foo}', input())).toEqual({ ok: false, reason: 'unknown-variable', name: 'foo' });
	});

	it('rejects templates whose structure is broken whatever the values', () => {
		expect(checkTemplate('/a/{hash}')).toEqual({ reason: 'leading-slash' });
		expect(checkTemplate('a//{hash}')).toEqual({ reason: 'empty-segment' });
		expect(checkTemplate('a/../{hash}')).toEqual({ reason: 'dot-segment' });
		expect(checkTemplate('a/{hash}/')).toEqual({ reason: 'empty-segment' });
	});

	it('accepts both defaults and keeps stray braces literal', () => {
		expect(checkTemplate(DEFAULT_KEY_TEMPLATE.public)).toBeUndefined();
		expect(checkTemplate(DEFAULT_KEY_TEMPLATE.private)).toBeUndefined();
		expect(expandTemplate('a/{ {hash}', values())).toEqual({ ok: true, key: 'a/{ 0123456789abcdef' });
	});

	it('lists identifying variables for the public warning', () => {
		expect(identifyingVariables(DEFAULT_KEY_TEMPLATE.public)).toEqual([]);
		expect(identifyingVariables(DEFAULT_KEY_TEMPLATE.private)).toEqual(['notename', 'filename']);
		expect(identifyingVariables('{foldername}/{hash}')).toEqual(['foldername']);
	});
});

describe('{ext} of attachments (design 3-2)', () => {
	it('keeps the source extension, lowercased, and uses bin without one', () => {
		expect(buildKey('a/{filename}.{ext}', input({ sourcePath: 'docs/Report.PDF', format: 'pdf' }))).toEqual({ ok: true, key: 'a/Report.pdf' });
		expect(buildKey('a/{hash}.{ext}', input({ sourcePath: 'docs/README', format: 'other' }))).toEqual({ ok: true, key: 'a/0123456789abcdef.bin' });
		expect(buildKey('a/{filename}.{ext}', input({ sourcePath: 'x/clip.mov', format: 'video' }))).toEqual({ ok: true, key: 'a/clip.mov' });
	});

	it('still follows the bytes sent for images (a converted image changes its extension)', () => {
		expect(buildKey('a/{filename}.{ext}', input({ sourcePath: 'x/photo.jpeg', format: 'webp' }))).toEqual({ ok: true, key: 'a/photo.webp' });
	});
});
