import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatReference } from '../src/reference/reference';
import { policyOf, policyOfContentType, TEXT_PREVIEW_UNITS, textPreview } from '../src/preview/service';
import { body, pngBytes, setupService } from './fixtures/preview';

const ref = (key: string) => formatReference('work', key);
const file = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/files/${name}`, import.meta.url)));
type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
const objects = (o: Record<string, { bytes: Uint8Array; type?: string }>) => async (command: Cmd) => {
	const obj = o[command.input.Key as string];
	if (!obj) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
	if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: obj.bytes.length, ContentType: obj.type };
	return { ContentLength: obj.bytes.length, Body: body(obj.bytes) };
};

describe('policyOf (design 7-1 step 1)', () => {
	it.each([
		['a.png', 'image'],
		['IMG_0001.JPG', 'image'],
		['a.Jpeg', 'image'],
		['a.svg', 'svg'],
		['notes.TXT', 'text'],
		['data.json', 'text'],
		['a', 'head'],
		['dir.v1/a', 'head'],
		['a.pdf', 'info'],
		['a.docx', 'info'],
		['a.heic', 'info'],
	])('%s → %s', (key, policy) => {
		expect(policyOf(key)).toBe(policy);
	});

	it('a key without an extension: only these Content-Types choose a policy', () => {
		expect(['image/svg+xml', 'text/plain; charset=utf-8', 'IMAGE/PNG', 'application/pdf', 'application/octet-stream', undefined].map(policyOfContentType)).toEqual([
			'svg',
			'text',
			'image',
			'info',
			'info',
			'info',
		]);
	});
});

describe('PreviewService — what is fetched (7-1)', () => {
	it('an uppercase image extension is still an image, as in Phase 2', async () => {
		const t = setupService();
		expect(await t.service.acquire(ref('IMG_0001.JPG')).result).toMatchObject({ width: 10, height: 10 });
	});

	it('PDF, Office, archives and media are never downloaded: Head only, shown as information', async () => {
		const t = setupService({ send: objects({ 'k/a.pdf': { bytes: file('p-ok.pdf') }, 'k/b.mp4': { bytes: file('v-mp4.mp4') }, 'k/c.heic': { bytes: new Uint8Array(9) } }) });
		expect(await t.service.acquire(ref('k/a.pdf')).result).toEqual({ kind: 'info', name: 'a.pdf', size: file('p-ok.pdf').length, type: 'pdf' });
		expect(await t.service.acquire(ref('k/b.mp4')).result).toMatchObject({ kind: 'info', type: 'video' });
		expect(await t.service.acquire(ref('k/c.heic')).result).toMatchObject({ kind: 'info', type: 'other' });
		expect(t.gets()).toEqual([]);
	});

	it('text and SVG are fetched and shown only if the bytes are what the key says', async () => {
		const t = setupService({
			send: objects({
				'k/a.txt': { bytes: file('t-plain.txt') },
				'k/b.txt': { bytes: file('b-html-as-txt.txt') },
				'k/c.svg': { bytes: file('a-img.svg') },
				'k/d.svg': { bytes: file('t-plain.txt') },
			}),
		});
		expect(await t.service.acquire(ref('k/a.txt')).result).toMatchObject({ kind: 'text', truncated: false });
		expect(await t.service.acquire(ref('k/b.txt')).result).toMatchObject({ kind: 'info', mismatch: true });
		expect(await t.service.acquire(ref('k/c.svg')).result).toEqual({ kind: 'svg', url: 'blob:test/1' });
		expect(await t.service.acquire(ref('k/d.svg')).result).toMatchObject({ kind: 'info', mismatch: true });
	});

	it('a key without an extension: Head chooses, the bytes decide; other Content-Types fetch nothing', async () => {
		const t = setupService({
			send: objects({
				'k/img': { bytes: pngBytes(10, 10), type: 'image/png' },
				'k/note': { bytes: file('t-plain.txt'), type: 'text/plain' },
				'k/lie': { bytes: file('a-page.html'), type: 'text/plain' },
				'k/blob': { bytes: pngBytes(10, 10), type: 'application/octet-stream' },
			}),
		});
		expect(await t.service.acquire(ref('k/img')).result).toMatchObject({ width: 10 });
		expect(await t.service.acquire(ref('k/note')).result).toMatchObject({ kind: 'text' });
		expect(await t.service.acquire(ref('k/lie')).result).toMatchObject({ kind: 'info', mismatch: true });
		expect(await t.service.acquire(ref('k/blob')).result).toMatchObject({ kind: 'info', type: 'other' });
		expect(t.gets().map((g) => g.key)).toEqual(['k/img', 'k/note', 'k/lie']);
	});

	it('text over maxTextMB is not read; a failed Head is shown as a failure', async () => {
		const big = new Uint8Array(6 * 1024 * 1024).fill(0x61);
		const t = setupService({ send: objects({ 'k/a.txt': { bytes: big } }) });
		await expect(t.service.acquire(ref('k/a.txt')).result).rejects.toMatchObject({ code: 'too-large' });
		await expect(t.service.acquire(ref('k/missing.pdf')).result).rejects.toMatchObject({ code: 'not-found' });
	});

	it('an SVG blob URL is revoked when the entry is dropped', async () => {
		const t = setupService({ send: objects({ 'k/c.svg': { bytes: file('a-img.svg') } }) });
		const lease = t.service.acquire(ref('k/c.svg'));
		await lease.result;
		lease.release();
		t.service.invalidateAll();
		expect(t.urls.revoked).toEqual(['blob:test/1']);
	});
});

describe('textPreview (7-2)', () => {
	it('keeps the first part, never half of a surrogate pair', () => {
		const s = 'a'.repeat(TEXT_PREVIEW_UNITS - 1) + '😀' + 'b';
		const r = textPreview(new TextEncoder().encode(s));
		expect(r.truncated).toBe(true);
		expect(r.text.length).toBe(TEXT_PREVIEW_UNITS - 1);
		expect(textPreview(new TextEncoder().encode('short'))).toEqual({ kind: 'text', text: 'short', truncated: false });
	});
});

describe('the preview modules never write files (7-2)', () => {
	it('no fs, vault.create* or adapter.write* in src/preview', () => {
		const dir = new URL('../src/preview/', import.meta.url);
		for (const name of readdirSync(dir)) {
			const text = readFileSync(join(dir.pathname, name), 'utf8');
			expect(text, name).not.toMatch(/from 'node:fs|from 'fs|require\('fs|vault\.create|adapter\.write|vault\.modify|vault\.append/);
		}
	});
});
