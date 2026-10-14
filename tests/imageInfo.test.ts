import { describe, expect, it } from 'vitest';
import { detectImage } from '../src/preview/imageInfo';

const png = (w: number, h: number) => {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, w);
	new DataView(b.buffer).setUint32(20, h);
	return b;
};
const gif = (w: number, h: number) => {
	const b = new Uint8Array(13);
	b.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
	new DataView(b.buffer).setUint16(6, w, true);
	new DataView(b.buffer).setUint16(8, h, true);
	return b;
};
const jpeg = (w: number, h: number) =>
	new Uint8Array([
		0xff, 0xd8, // SOI
		0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 (length 4)
		0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
	]);
const webpVp8x = (w: number, h: number) => {
	const b = new Uint8Array(30);
	b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
	b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
	const W = w - 1, H = h - 1;
	b.set([W & 0xff, (W >> 8) & 0xff, (W >> 16) & 0xff, H & 0xff, (H >> 8) & 0xff, (H >> 16) & 0xff], 24);
	return b;
};
const text = (s: string) => new TextEncoder().encode(s);

describe('detectImage', () => {
	it('reads format and size from headers', () => {
		expect(detectImage(png(320, 200))).toMatchObject({ kind: 'image', format: 'png', mime: 'image/png', width: 320, height: 200 });
		expect(detectImage(gif(16, 9))).toMatchObject({ format: 'gif', width: 16, height: 9 });
		expect(detectImage(jpeg(640, 480))).toMatchObject({ format: 'jpeg', width: 640, height: 480 });
		expect(detectImage(webpVp8x(5000, 4000))).toMatchObject({ format: 'webp', width: 5000, height: 4000 });
	});

	it('reads a lossy 1x1 WebP', () => {
		const webp = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'), (c) => c.charCodeAt(0));
		expect(detectImage(webp)).toMatchObject({ format: 'webp', width: 1, height: 1 });
	});

	it('finds the JPEG frame header after other segments', () => {
		const withExif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4, 0xff, 0xdb, 0x00, 0x03, 0, ...jpeg(320, 200).slice(2)]);
		expect(detectImage(withExif)).toMatchObject({ format: 'jpeg', width: 320, height: 200 });
	});

	it('recognizes SVG and rejects everything else', () => {
		expect(detectImage(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ kind: 'svg' });
		expect(detectImage(text('﻿  <?xml version="1.0"?><svg/>'))).toEqual({ kind: 'svg' });
		expect(detectImage(text('<html><body>'))).toEqual({ kind: 'unknown' });
		expect(detectImage(text('plain'))).toEqual({ kind: 'unknown' });
		expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ kind: 'unknown' }); // JPEG without SOF
		expect(detectImage(png(0, 10))).toEqual({ kind: 'unknown' });
		expect(detectImage(new Uint8Array())).toEqual({ kind: 'unknown' });
	});
});
