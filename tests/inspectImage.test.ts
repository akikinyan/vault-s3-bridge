import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectImage, inspectImage, type ImageInspection } from '../src/preview/imageInfo';

// Fixed byte sequences, generated once on macOS (JPEG base from sips, VP8 data and chrome-out.* from Chrome),
// because CI cannot produce them. Metadata carries the marker "example-marker" and GPS 0,0.
const load = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url)));

const still = (format: 'png' | 'jpeg' | 'gif' | 'webp', metadata: string[] = [], extra: object = {}) => ({
	kind: 'image', format, width: 300, height: 200, frames: 1, metadata, ...extra,
});

const EXPECTED: Record<string, ImageInspection | object> = {
	'png-plain.png': still('png'),
	'png-meta.png': still('png', ['exif', 'gps', 'xmp', 'text']),
	'apng-anim.png': { ...still('png'), frames: 2 },
	// Two APP1 Exif blocks (ours with orientation, then the size-only one sips wrote) and sips' APP13.
	'jpeg-gps-rot1.jpg': still('jpeg', ['exif', 'gps', 'xmp', 'iptc', 'comment'], { orientation: 1 }),
	'jpeg-gps-rot6.jpg': still('jpeg', ['exif', 'gps', 'xmp', 'iptc', 'comment'], { orientation: 6 }),
	'gif-static.gif': still('gif', ['comment']),
	'gif-anim.gif': { ...still('gif'), frames: 2 },
	'webp-plain.webp': still('webp'),
	'webp-meta.webp': still('webp', ['exif', 'gps', 'xmp']),
	'webp-anim.webp': { ...still('webp'), frames: 2 },
	'big-39_998_000px.png': { ...still('png'), width: 7000, height: 5714 },
	'big-48_000_000px.png': { ...still('png'), width: 8000, height: 6000 },
	'broken-truncated.png': { kind: 'rejected', reason: 'malformed', detail: 'overrun:chunk:IDAT' },
	'broken-truncated.jpg': { kind: 'rejected', reason: 'malformed', detail: 'no-EOI' },
	'broken-truncated.gif': { kind: 'rejected', reason: 'malformed', detail: 'overrun:sub-block' },
	'broken-truncated.webp': { kind: 'rejected', reason: 'malformed', detail: 'riff-size>file' },
	'broken-not-image.png': { kind: 'rejected', reason: 'unknown-format' },
	'broken-empty.png': { kind: 'rejected', reason: 'unknown-format' },
	// Real re-encoder output: only the sRGB profile Chrome always writes.
	'chrome-out.jpg': { ...still('jpeg', ['icc']), width: 200, height: 300 },
	'chrome-out.png': still('png'),
	'chrome-out.webp': still('webp', ['icc']),
};
const NAMES = Object.keys(EXPECTED);
const SMALL = NAMES.filter((n) => !n.startsWith('big-') && !n.startsWith('broken-'));

const bytes = (...parts: (Uint8Array | number[] | string)[]) => {
	const arrays = parts.map((p) => (typeof p === 'string' ? new TextEncoder().encode(p) : Uint8Array.from(p)));
	const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
	let o = 0;
	for (const a of arrays) {
		out.set(a, o);
		o += a.length;
	}
	return out;
};
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const le32 = (n: number) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const indexOf = (b: Uint8Array, seq: number[] | string, from = 0) => {
	const s = typeof seq === 'string' ? [...seq].map((c) => c.charCodeAt(0)) : seq;
	outer: for (let i = from; i + s.length <= b.length; i++) {
		for (let j = 0; j < s.length; j++) if (b[i + j] !== s[j]) continue outer;
		return i;
	}
	return -1;
};
const pngChunk = (type: string, data: number[] | Uint8Array = []) => bytes(be32(data.length), type, data, [0, 0, 0, 0]); // CRC is not checked
/** Rebuilds a RIFF/WEBP file from chunks, fixing the RIFF size. */
const riff = (...chunks: Uint8Array[]) => {
	const body = bytes('WEBP', ...chunks);
	return bytes('RIFF', le32(body.length), body);
};
const riffChunk = (type: string, data: Uint8Array | number[]) => {
	const d = Uint8Array.from(data);
	return bytes(type, le32(d.length), d, d.length & 1 ? [0] : []);
};
/** Splits a WebP file into its top-level chunks (type + payload). */
const webpChunks = (b: Uint8Array) => {
	const out: { type: string; data: Uint8Array }[] = [];
	for (let o = 12; o + 8 <= b.length; ) {
		const len = b[o + 4]! | (b[o + 5]! << 8) | (b[o + 6]! << 16) | (b[o + 7]! << 24);
		out.push({ type: String.fromCharCode(...b.subarray(o, o + 4)), data: b.subarray(o + 8, o + 8 + len) });
		o += 8 + len + (len & 1);
	}
	return out;
};
const rejected = (b: Uint8Array) => {
	const r = inspectImage(b);
	return r.kind === 'rejected' ? r.reason : 'accepted';
};
const detailOf = (b: Uint8Array) => {
	const r = inspectImage(b);
	return r.kind === 'rejected' ? r.detail : undefined;
};
const metadataOf = (b: Uint8Array) => {
	const r = inspectImage(b);
	return r.kind === 'image' ? r.metadata : r;
};

describe('inspectImage: fixtures', () => {
	it.each(NAMES)('%s', (name) => {
		expect(inspectImage(load(name))).toEqual(EXPECTED[name]);
	});

	it('agrees with detectImage on format and size for every accepted fixture', () => {
		for (const name of NAMES) {
			const r = inspectImage(load(name));
			if (r.kind !== 'image') continue;
			expect(detectImage(load(name)), name).toMatchObject({ kind: 'image', format: r.format, width: r.width, height: r.height });
		}
	});

	it('really carries the marker in the metadata fixtures (positive control)', () => {
		for (const name of ['png-meta.png', 'jpeg-gps-rot1.jpg', 'jpeg-gps-rot6.jpg', 'gif-static.gif', 'webp-meta.webp']) {
			expect(indexOf(load(name), 'example-marker'), name).toBeGreaterThan(0);
		}
		for (const name of ['png-plain.png', 'webp-plain.webp', 'chrome-out.jpg', 'chrome-out.png', 'chrome-out.webp']) {
			expect(indexOf(load(name), 'example-marker'), name).toBe(-1);
		}
	});

	it('rejects every strict prefix of a valid image', () => {
		fc.assert(
			fc.property(fc.constantFrom(...SMALL), fc.double({ min: 0, max: 1, noNaN: true, maxExcluded: true }), (name, ratio) => {
				const b = load(name);
				const cut = b.subarray(0, Math.floor(b.length * ratio));
				expect(inspectImage(cut).kind).toBe('rejected');
			}),
			{ numRuns: 300 },
		);
	});

	it('never throws on corrupted bytes', () => {
		fc.assert(
			fc.property(fc.constantFrom(...SMALL), fc.array(fc.tuple(fc.nat(), fc.nat({ max: 255 })), { minLength: 1, maxLength: 8 }), (name, edits) => {
				const b = load(name).slice();
				for (const [i, v] of edits) b[i % b.length] = v;
				expect(() => inspectImage(b)).not.toThrow();
			}),
			{ numRuns: 500 },
		);
	});
});

describe('inspectImage: structure', () => {
	it('classifies non-images', () => {
		expect(inspectImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({ kind: 'rejected', reason: 'svg' });
		expect(rejected(new TextEncoder().encode('<html>'))).toBe('unknown-format');
	});

	it('PNG: requires IHDR first, IDAT and enough fcTL for acTL; zero size is no-size', () => {
		const b = load('png-plain.png');
		const withoutIhdr = bytes(b.subarray(0, 8), b.subarray(33));
		expect(detailOf(withoutIhdr)).toBe('IHDR-not-first');
		const idat = indexOf(b, 'IDAT') - 4;
		const iend = indexOf(b, 'IEND') - 4;
		expect(detailOf(bytes(b.subarray(0, idat), b.subarray(iend)))).toBe('no-IDAT');
		const anim = load('apng-anim.png');
		const fctl = indexOf(anim, 'fcTL', indexOf(anim, 'fcTL') + 1) - 4; // drop the second fcTL (26-byte payload)
		expect(detailOf(bytes(anim.subarray(0, fctl), anim.subarray(fctl + 38)))).toBe('fcTL-1<acTL-2');
		const zero = b.slice();
		zero.set([0, 0, 0, 0], 16);
		expect(rejected(zero)).toBe('no-size');
	});

	it('JPEG: requires SOS before EOI and a terminating EOI', () => {
		const b = load('chrome-out.jpg');
		const sos = indexOf(b, [0xff, 0xda]);
		expect(detailOf(bytes(b.subarray(0, sos), [0xff, 0xd9]))).toBe('no-SOS'); // cut between SOF and SOS
		expect(rejected(b.subarray(0, sos))).toBe('malformed');
		expect(detailOf(b.subarray(0, b.length - 2))).toBe('no-EOI');
		const sof = indexOf(b, [0xff, 0xc0]);
		expect(detailOf(bytes(b.subarray(0, 2), b.subarray(sos)))).toBe('SOS-before-SOF');
		// A second frame header with another size would let the decoder see a different image.
		const sofSeg = b.subarray(sof, sof + 19);
		const other = sofSeg.slice();
		other[5] = 0x7f;
		expect(detailOf(bytes(b.subarray(0, sos), other, b.subarray(sos)))).toBe('SOF-size-mismatch');
		expect(rejected(bytes(b.subarray(0, sos), sofSeg, b.subarray(sos)))).toBe('accepted');
	});

	it('JPEG: takes the orientation from the first Exif block only', () => {
		const b = load('jpeg-gps-rot6.jpg');
		// Big-endian TIFF with a single IFD0 entry: Orientation (SHORT) = 1.
		const tiff = [0x4d, 0x4d, 0, 42, ...be32(8), 0, 1, 0x01, 0x12, 0, 3, ...be32(1), 0, 1, 0, 0, ...be32(0)];
		const second = bytes([0xff, 0xe1, 0, 2 + 6 + tiff.length], 'Exif\0\0', tiff);
		const sos = indexOf(b, [0xff, 0xda]);
		expect(inspectImage(bytes(b.subarray(0, sos), second, b.subarray(sos)))).toMatchObject({ orientation: 6 });
		const alone = bytes(load('chrome-out.jpg').subarray(0, 2), second, load('chrome-out.jpg').subarray(2));
		expect(inspectImage(alone)).toMatchObject({ orientation: 1, metadata: ['exif', 'icc'] });
	});

	it('GIF: rejects a frame outside the logical screen', () => {
		const b = load('gif-static.gif').slice();
		b[6] = 100; // logical width 300 → 100 while the frame stays 300 wide
		b[7] = 0;
		expect(detailOf(b)).toBe('frame-outside-screen');
	});

	it('WebP: checks chunk bounds against the RIFF size, frame tags and canvas consistency', () => {
		const plain = load('webp-plain.webp');
		const shortRiff = plain.slice();
		shortRiff.set(le32(plain.length - 8 - 10), 4); // container ends 10 bytes before the VP8 data does
		expect(detailOf(shortRiff)).toBe('chunk-overrun:VP8 ');
		const badTag = plain.slice();
		badTag[20 + 3] = 0;
		expect(detailOf(badTag)).toBe('VP8-frame-tag');
		expect(detectImage(badTag)).toEqual({ kind: 'unknown' });

		const [vp8x, vp8, ...rest] = webpChunks(load('webp-meta.webp'));
		expect([vp8x?.type, vp8?.type]).toEqual(['VP8X', 'VP8 ']);
		const header = riffChunk('VP8X', vp8x!.data);
		expect(detailOf(riff(header))).toBe('image-chunks:0');
		const wide = vp8x!.data.slice();
		wide[4] = (wide[4]! + 1) & 0xff; // canvas 301 wide, VP8 data still 300
		expect(detailOf(riff(riffChunk('VP8X', wide), riffChunk('VP8 ', vp8!.data)))).toBe('canvas-size-mismatch');
		expect(rejected(riff(header, riffChunk('VP8 ', vp8!.data), ...rest.map((c) => riffChunk(c.type, c.data))))).toBe('accepted');

		const [ax, anim, anmf] = webpChunks(load('webp-anim.webp'));
		const outside = anmf!.data.slice();
		outside[0] = 1; // frame X offset 2 → 2 + 300 > 300
		expect(detailOf(riff(riffChunk('VP8X', ax!.data), riffChunk('ANIM', anim!.data), riffChunk('ANMF', outside)))).toBe('frame-outside-canvas');
		expect(detailOf(riff(riffChunk('VP8X', ax!.data), riffChunk('ANIM', anim!.data)))).toBe('animation-without-frames');
	});
});

describe('inspectImage: metadata', () => {
	it('reports EXIF GPS by the IFD pointer even at 0,0', () => {
		expect(metadataOf(load('png-meta.png'))).toContain('gps');
	});

	it('reports unknown JPEG segments, PNG chunks, WebP chunks and GIF extensions as other', () => {
		const jpeg = load('chrome-out.jpg');
		const app3 = [0xff, 0xe3, 0x00, 0x06, 0x41, 0x42, 0x43, 0x44];
		expect(metadataOf(bytes(jpeg.subarray(0, 2), app3, jpeg.subarray(2)))).toEqual(['icc', 'other']);
		const mpf = bytes([0xff, 0xe2, 0x00, 0x06], 'MPF\0');
		expect(metadataOf(bytes(jpeg.subarray(0, 2), mpf, jpeg.subarray(2)))).toEqual(['icc', 'other']);
		const app13 = bytes([0xff, 0xed, 0x00, 0x10], 'Photoshop 3.0\0');
		expect(metadataOf(bytes(jpeg.subarray(0, 2), app13, jpeg.subarray(2)))).toEqual(['iptc', 'icc']);

		const png = load('chrome-out.png');
		expect(metadataOf(bytes(png.subarray(0, 33), pngChunk('tIME', [7, 234, 10, 17, 0, 0, 0]), png.subarray(33)))).toEqual(['other']);
		expect(metadataOf(bytes(png.subarray(0, 33), pngChunk('pHYs', [0, 0, 11, 19, 0, 0, 11, 19, 1]), png.subarray(33)))).toEqual([]);

		const chunks = webpChunks(load('chrome-out.webp')).map((c) => riffChunk(c.type, c.data));
		expect(metadataOf(riff(...chunks, riffChunk('abcd', [1, 2])))).toEqual(['icc', 'other']);

		const gif = load('gif-anim.gif');
		const ext = bytes([0x21, 0xff, 0x0b], 'EXAMPLE1.0X', [3, 1, 2, 3, 0]);
		expect(metadataOf(bytes(gif.subarray(0, gif.length - 1), ext, [0x3b]))).toEqual(['other']);
	});

	it('reports bytes after the end of the image as other', () => {
		for (const name of ['chrome-out.jpg', 'chrome-out.png', 'chrome-out.webp', 'gif-anim.gif']) {
			expect(metadataOf(bytes(load(name), 'example-marker')), name).toContain('other');
		}
	});
});
