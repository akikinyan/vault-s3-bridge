import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	type ConvertPolicy,
	type DecodedImage,
	type Encoder,
	ORIGINAL_CONVERTER,
	prepareBytes,
	rebuildBytes,
	sha256Hex,
	UPLOAD_MAX_PIXELS,
} from '../src/upload/convert';

const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url)));

type Mime = 'image/png' | 'image/jpeg' | 'image/webp';

/** Decodes to a fixed size and "encodes" by returning prepared outputs; records every call. */
class FakeEncoder implements Encoder {
	readonly electronVersion = '38.0.0';
	decodes: string[] = [];
	encodes: { type: Mime; quality?: number }[] = [];
	closed = 0;
	constructor(
		private readonly outputs: Partial<Record<Mime, Uint8Array>>,
		private readonly size: [number, number] = [300, 200],
		private readonly failDecode = false,
	) {}
	decode(_bytes: Uint8Array, mime: string): Promise<DecodedImage> {
		this.decodes.push(mime);
		if (this.failDecode) return Promise.reject(new Error('cannot decode'));
		const [width, height] = this.size;
		return Promise.resolve({
			width,
			height,
			encode: (type: Mime, quality?: number) => {
				this.encodes.push(quality === undefined ? { type } : { type, quality });
				const out = this.outputs[type];
				return out ? Promise.resolve(out) : Promise.reject(new Error('no output'));
			},
			close: () => {
				this.closed++;
			},
		});
	}
}

const PNG_OUT = load('chrome-out.png'); // 300x200, no metadata
const WEBP_OUT = load('chrome-out.webp'); // 300x200, ICC only
const JPEG_OUT = load('chrome-out.jpg'); // 200x300, ICC only
/** A structurally valid PNG of the given size (inspectImage does not inflate IDAT or check CRCs). */
function tinyPng(width: number, height: number): Uint8Array {
	const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
	const chunk = (type: string, data: number[]) => [...be32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
	return Uint8Array.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
		...chunk('IHDR', [...be32(width), ...be32(height), 8, 2, 0, 0, 0]),
		...chunk('IDAT', [0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]),
		...chunk('IEND', []),
	]);
}
const goodOutputs = () => new FakeEncoder({ 'image/png': PNG_OUT, 'image/webp': WEBP_OUT });

const policy = (over: Partial<ConvertPolicy> = {}): ConvertPolicy => ({
	classification: 'public',
	stripPrivate: false,
	webp: { enabled: false, quality: 0.85 },
	maxFileMB: 20,
	...over,
});

describe('prepareBytes (4-2)', () => {
	it('public: re-encodes a still PNG to PNG, checks it, and names the method with the Electron version', async () => {
		const enc = goodOutputs();
		const r = await prepareBytes(load('png-meta.png'), policy(), enc);
		expect(r).toMatchObject({ ok: true, format: 'png', converter: 'c1;png;electron=38.0.0', reencoded: true, sourceFormat: 'png' });
		if (!r.ok) return;
		expect(r.bytes).toBe(PNG_OUT);
		expect(r.sentSha256).toBe(sha256Hex(PNG_OUT));
		expect(enc.decodes).toEqual(['image/png']);
		expect(enc.encodes).toEqual([{ type: 'image/png' }]);
		expect(enc.closed).toBe(1);
	});

	it('a still GIF becomes PNG; JPEG uses quality 0.92; WebP uses the set quality', async () => {
		expect(await prepareBytes(load('gif-static.gif'), policy(), goodOutputs())).toMatchObject({ ok: true, format: 'png', sourceFormat: 'gif' });
		const j = new FakeEncoder({ 'image/jpeg': JPEG_OUT }, [200, 300]);
		expect(await prepareBytes(load('jpeg-gps-rot6.jpg'), policy(), j)).toMatchObject({ ok: true, format: 'jpeg', converter: 'c1;jpeg@0.92;electron=38.0.0' });
		expect(j.encodes).toEqual([{ type: 'image/jpeg', quality: 0.92 }]);
		const w = goodOutputs();
		expect(await prepareBytes(load('webp-meta.webp'), policy({ webp: { enabled: false, quality: 0.7 } }), w)).toMatchObject({ ok: true, format: 'webp', converter: 'c1;webp@0.7;electron=38.0.0' });
		expect(w.encodes).toEqual([{ type: 'image/webp', quality: 0.7 }]);
	});

	it('with WebP enabled, sends the smaller output, even if larger than the source (D6)', async () => {
		const small = WEBP_OUT.length < PNG_OUT.length ? 'webp' : 'png';
		const r = await prepareBytes(load('png-plain.png'), policy({ webp: { enabled: true, quality: 0.85 } }), goodOutputs());
		expect(r).toMatchObject({ ok: true, format: small });
		// Same-format output only: a tiny source still sends the (bigger) re-encoded output.
		const tiny = await prepareBytes(load('png-plain.png'), policy(), new FakeEncoder({ 'image/png': PNG_OUT }));
		expect(tiny).toMatchObject({ ok: true, reencoded: true });
		if (tiny.ok) expect(tiny.bytes).toBe(PNG_OUT);
		// A WebP source is encoded once, as WebP.
		const w = goodOutputs();
		expect(await prepareBytes(load('webp-plain.webp'), policy({ webp: { enabled: true, quality: 0.85 } }), w)).toMatchObject({ ok: true, format: 'webp' });
		expect(w.encodes).toEqual([{ type: 'image/webp', quality: 0.85 }]);
	});

	it('with WebP enabled, both are produced and the smaller is taken', async () => {
		const enc = goodOutputs();
		const r = await prepareBytes(load('png-plain.png'), policy({ webp: { enabled: true, quality: 0.85 } }), enc);
		expect(enc.encodes.map((e) => e.type)).toEqual(['image/png', 'image/webp']);
		expect(r.ok && r.bytes.length).toBe(Math.min(PNG_OUT.length, WEBP_OUT.length));
		expect(WEBP_OUT.length).toBeLessThan(PNG_OUT.length);
		// The other way round: a PNG smaller than the WebP wins.
		const smallPng = tinyPng(300, 200);
		expect(smallPng.length).toBeLessThan(WEBP_OUT.length);
		const r2 = await prepareBytes(load('png-plain.png'), policy({ webp: { enabled: true, quality: 0.85 } }), new FakeEncoder({ 'image/png': smallPng, 'image/webp': WEBP_OUT }));
		expect(r2).toMatchObject({ ok: true, format: 'png', converter: 'c1;png;electron=38.0.0' });
	});

	it('private without stripping sends the original, animation included, as c1;orig', async () => {
		const enc = goodOutputs();
		const src = load('apng-anim.png');
		const r = await prepareBytes(src, policy({ classification: 'private' }), enc);
		expect(r).toEqual({ ok: true, bytes: src, format: 'png', converter: ORIGINAL_CONVERTER, sentSha256: sha256Hex(src), sourceFormat: 'png', reencoded: false });
		expect(enc.decodes).toEqual([]);
		expect(await prepareBytes(load('gif-anim.gif'), policy({ classification: 'private' }), enc)).toMatchObject({ ok: true, format: 'gif' });
	});

	it('private with stripping is treated like public', async () => {
		expect(await prepareBytes(load('png-meta.png'), policy({ classification: 'private', stripPrivate: true }), goodOutputs())).toMatchObject({ ok: true, reencoded: true });
		expect(await prepareBytes(load('apng-anim.png'), policy({ classification: 'private', stripPrivate: true }), goodOutputs())).toEqual({ ok: false, reason: 'animated' });
	});

	it.each(['apng-anim.png', 'gif-anim.gif', 'webp-anim.webp'])('public rejects animation: %s', async (name) => {
		const enc = goodOutputs();
		expect(await prepareBytes(load(name), policy(), enc)).toEqual({ ok: false, reason: 'animated' });
		expect(enc.decodes).toEqual([]);
	});

	it('rejects what the header check rejects, on every connection', async () => {
		for (const classification of ['public', 'private'] as const) {
			for (const name of ['broken-truncated.png', 'broken-not-image.png', 'broken-empty.png']) {
				expect(await prepareBytes(load(name), policy({ classification }), goodOutputs())).toMatchObject({ ok: false, reason: 'unsupported' });
			}
			expect(await prepareBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), policy({ classification }), goodOutputs())).toEqual({
				ok: false,
				reason: 'unsupported',
				detail: 'svg',
			});
		}
	});

	it('rejects over 40 MP from the header without decoding, on every connection; just under is decoded', async () => {
		expect(UPLOAD_MAX_PIXELS).toBe(40_000_000);
		for (const classification of ['public', 'private'] as const) {
			const enc = goodOutputs();
			expect(await prepareBytes(load('big-48_000_000px.png'), policy({ classification }), enc)).toEqual({ ok: false, reason: 'too-many-pixels' });
			expect(enc.decodes).toEqual([]);
		}
		const enc = new FakeEncoder({ 'image/png': PNG_OUT }, [7000, 5714]);
		await prepareBytes(load('big-39_998_000px.png'), policy(), enc);
		expect(enc.decodes).toHaveLength(1);
	});

	it('rejects a file over maxFileMB on every connection', async () => {
		const src = load('png-plain.png');
		const limit = src.length / (1024 * 1024);
		for (const classification of ['public', 'private'] as const) {
			expect(await prepareBytes(src, policy({ classification, maxFileMB: limit * 0.999 }), goodOutputs())).toEqual({ ok: false, reason: 'too-large' });
			expect(await prepareBytes(src, policy({ classification, maxFileMB: limit }), goodOutputs())).toMatchObject({ ok: true });
		}
	});

	it('decode failure', async () => {
		const enc = new FakeEncoder({}, [300, 200], true);
		expect(await prepareBytes(load('png-plain.png'), policy(), enc)).toEqual({ ok: false, reason: 'decode-failed' });
	});
});

describe('output check (4-3 step 4): a bad output is rejected, never replaced by the original', () => {
	it.each([
		['metadata left', { 'image/png': load('png-meta.png') }, [300, 200], 'output-metadata:exif,gps,xmp,text'],
		['wrong format', { 'image/png': WEBP_OUT }, [300, 200], 'output-format:webp'],
		['animated', { 'image/png': load('apng-anim.png') }, [300, 200], 'output-frames'],
		['malformed', { 'image/png': load('broken-truncated.png') }, [300, 200], 'output:malformed'],
		['size differs from the decoded bitmap', { 'image/png': PNG_OUT }, [200, 300], 'output-size'],
		['encoder error', {}, [300, 200], 'encode-error'],
	] as const)('%s', async (_, outputs, size, detail) => {
		const enc = new FakeEncoder(outputs, [...size]);
		expect(await prepareBytes(load('png-meta.png'), policy(), enc)).toEqual({ ok: false, reason: 'strip-failed', detail });
		expect(enc.closed).toBe(1);
	});

	it('the size is compared with the decoded bitmap, not the source header (orientation applied)', async () => {
		// Source header says 300x200 with orientation 6; the decoder rotates it to 200x300.
		const enc = new FakeEncoder({ 'image/jpeg': JPEG_OUT }, [200, 300]);
		expect(await prepareBytes(load('jpeg-gps-rot6.jpg'), policy(), enc)).toMatchObject({ ok: true });
	});

	it('a JPEG output that still carries Exif and GPS is rejected', async () => {
		const enc = new FakeEncoder({ 'image/jpeg': load('jpeg-gps-rot1.jpg') }, [300, 200]);
		const r = await prepareBytes(load('jpeg-gps-rot1.jpg'), policy(), enc);
		expect(r).toMatchObject({ ok: false, reason: 'strip-failed' });
		expect(r.ok ? '' : (r.detail ?? '')).toMatch(/^output-metadata:.*exif.*gps/);
	});

	it('a bad WebP candidate rejects the whole conversion even when the same-format output is fine', async () => {
		const enc = new FakeEncoder({ 'image/png': PNG_OUT, 'image/webp': load('webp-meta.webp') });
		expect(await prepareBytes(load('png-plain.png'), policy({ webp: { enabled: true, quality: 0.85 } }), enc)).toEqual({
			ok: false,
			reason: 'strip-failed',
			detail: 'output-metadata:exif,gps,xmp',
		});
	});
});

describe('rebuildBytes (6-5 step 2)', () => {
	const src = load('png-meta.png');
	const record = { sourceSha256: sha256Hex(src), sentSha256: sha256Hex(PNG_OUT), converter: 'c1;png;electron=38.0.0', format: 'png' as const };

	it('makes the same bytes again with the recorded method', async () => {
		expect(await rebuildBytes(src, record, goodOutputs())).toBe(PNG_OUT);
		const orig = { sourceSha256: sha256Hex(src), sentSha256: sha256Hex(src), converter: ORIGINAL_CONVERTER, format: 'png' as const };
		expect(await rebuildBytes(src, orig, goodOutputs())).toBe(src);
	});

	it('uses the recorded method even if the settings now choose another', async () => {
		const enc = goodOutputs();
		const rec = { ...record, sentSha256: sha256Hex(WEBP_OUT), converter: 'c1;webp@0.85;electron=38.0.0', format: 'webp' as const };
		expect(await rebuildBytes(src, rec, enc)).toBe(WEBP_OUT);
		expect(enc.encodes).toEqual([{ type: 'image/webp', quality: 0.85 }]);
	});

	it.each([
		['the source changed', { sourceSha256: sha256Hex(PNG_OUT) }],
		['another Electron', { converter: 'c1;png;electron=37.0.0' }],
		['unknown converter', { converter: 'c2;png;electron=38.0.0' }],
		['format does not match the method', { format: 'webp' as const }],
		['other bytes than recorded', { sentSha256: sha256Hex(WEBP_OUT) }],
	])('undefined when %s', async (_, over) => {
		const enc = goodOutputs();
		expect(await rebuildBytes(src, { ...record, ...over }, enc)).toBeUndefined();
	});

	it('repeats JPEG only at the fixed quality', async () => {
		const src = load('jpeg-gps-rot6.jpg');
		const rec = { sourceSha256: sha256Hex(src), sentSha256: sha256Hex(JPEG_OUT), converter: 'c1;jpeg@0.92;electron=38.0.0', format: 'jpeg' as const };
		const enc = () => new FakeEncoder({ 'image/jpeg': JPEG_OUT }, [200, 300]);
		expect(await rebuildBytes(src, rec, enc())).toBe(JPEG_OUT);
		expect(await rebuildBytes(src, { ...rec, converter: 'c1;jpeg@0.8;electron=38.0.0' }, enc())).toBeUndefined();
	});

	it('does not decode for another Electron', async () => {
		const enc = goodOutputs();
		await rebuildBytes(src, { ...record, converter: 'c1;png;electron=37.0.0' }, enc);
		expect(enc.decodes).toEqual([]);
	});
});
