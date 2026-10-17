export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';

export type ImageInfo =
	| { kind: 'image'; format: ImageFormat; mime: string; width: number; height: number }
	| { kind: 'svg' }
	| { kind: 'unknown' };

const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

const be16 = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const be32 = (b: Uint8Array, i: number) => ((be16(b, i) << 16) >>> 0) + be16(b, i + 2);
const le24 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function image(format: ImageFormat, width: number, height: number): ImageInfo {
	return width > 0 && height > 0 ? { kind: 'image', format, mime: MIME[format], width, height } : { kind: 'unknown' };
}

function jpegSize(b: Uint8Array): [number, number] | undefined {
	let i = 2;
	while (i + 9 < b.length) {
		if (b[i] !== 0xff) return undefined;
		let marker = b[i + 1] ?? 0;
		while (marker === 0xff && i + 2 < b.length) marker = b[++i + 1] ?? 0;
		if (marker === 0xd9 || marker === 0xda) return undefined; // end of image / start of scan
		if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
			i += 2;
			continue;
		}
		const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isSof) return [be16(b, i + 7), be16(b, i + 5)];
		i += 2 + be16(b, i + 2);
	}
	return undefined;
}

function webpSize(b: Uint8Array): [number, number] | undefined {
	const chunk = ascii(b, 12, 4);
	if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return [le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff];
	if (chunk === 'VP8L' && b[20] === 0x2f) {
		const b1 = b[21] ?? 0, b2 = b[22] ?? 0, b3 = b[23] ?? 0, b4 = b[24] ?? 0;
		return [1 + (((b2 & 0x3f) << 8) | b1), 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6))];
	}
	if (chunk === 'VP8X') return [1 + le24(b, 24), 1 + le24(b, 27)];
	return undefined;
}

function looksLikeSvg(b: Uint8Array): boolean {
	const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, 1024)).replace(/^\uFEFF/, '').trimStart().toLowerCase();
	return head.startsWith('<svg') || ((head.startsWith('<?xml') || head.startsWith('<!doctype svg')) && head.includes('<svg'));
}

/** Detects the format from the bytes (never from Content-Type) and reads the pixel size. */
export function detectImage(b: Uint8Array): ImageInfo {
	if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && ascii(b, 12, 4) === 'IHDR') return image('png', be32(b, 16), be32(b, 20));
	if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return image('gif', le16(b, 6), le16(b, 8));
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		const size = jpegSize(b);
		return size ? image('jpeg', size[0], size[1]) : { kind: 'unknown' };
	}
	if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
		const size = webpSize(b);
		return size ? image('webp', size[0], size[1]) : { kind: 'unknown' };
	}
	if (looksLikeSvg(b)) return { kind: 'svg' };
	return { kind: 'unknown' };
}

// ---------------------------------------------------------------------------
// Upload-side inspection. Stricter than detectImage: walks the whole structure,
// counts frames and reports every kind of metadata it finds (unknown extras are
// reported as 'other', so a re-encoded output that still carries them is rejected).

export type MetadataKind = 'exif' | 'gps' | 'xmp' | 'text' | 'icc' | 'comment' | 'iptc' | 'other';

export type ImageInspection =
	| { kind: 'image'; format: ImageFormat; width: number; height: number; frames: number; metadata: MetadataKind[]; orientation?: number }
	| { kind: 'rejected'; reason: 'unknown-format' | 'svg' | 'malformed' | 'no-size'; detail?: string };

class Malformed extends Error {}

/** Throws unless n bytes from offset o are inside b. */
function need(b: Uint8Array, o: number, n: number, what: string): void {
	if (o < 0 || n < 0 || o + n > b.length) throw new Malformed(`overrun:${what}`);
}

const le32 = (b: Uint8Array, i: number) => (le16(b, i) + le16(b, i + 2) * 0x10000) >>> 0;

interface Parsed {
	format: ImageFormat;
	width: number;
	height: number;
	frames: number;
	metadata: Set<MetadataKind>;
	orientation?: number;
}

/** Reads IFD0 of a TIFF (EXIF) block; returns tag → value for SHORT/LONG entries. Never throws. */
function ifd0Tags(t: Uint8Array): Map<number, number> {
	const tags = new Map<number, number>();
	if (t.length < 8) return tags;
	const little = t[0] === 0x49 && t[1] === 0x49;
	if (!little && !(t[0] === 0x4d && t[1] === 0x4d)) return tags;
	const r16 = (o: number) => (little ? le16(t, o) : be16(t, o));
	const r32 = (o: number) => (little ? le32(t, o) : be32(t, o));
	const ifd = r32(4);
	if (ifd + 2 > t.length) return tags;
	const count = r16(ifd);
	for (let i = 0; i < count; i++) {
		const e = ifd + 2 + i * 12;
		if (e + 12 > t.length) break;
		tags.set(r16(e), r16(e + 2) === 3 ? r16(e + 8) : r32(e + 8));
	}
	return tags;
}

function addExif(p: Parsed, tiff: Uint8Array, readOrientation: boolean): void {
	p.metadata.add('exif');
	const tags = ifd0Tags(tiff);
	if (tags.has(0x8825)) p.metadata.add('gps');
	const orientation = tags.get(0x0112);
	if (readOrientation && orientation !== undefined && orientation >= 1 && orientation <= 8) p.orientation = orientation;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks that carry no information about the author, place or time. */
const PNG_HARMLESS = new Set(['PLTE', 'tRNS', 'pHYs', 'sRGB', 'gAMA', 'cHRM', 'sBIT', 'bKGD', 'acTL', 'fcTL', 'fdAT']);

function inspectPng(b: Uint8Array): Parsed {
	need(b, 8, 25, 'IHDR');
	if (ascii(b, 12, 4) !== 'IHDR' || be32(b, 8) !== 13) throw new Malformed('IHDR-not-first');
	const p: Parsed = { format: 'png', width: be32(b, 16), height: be32(b, 20), frames: 1, metadata: new Set() };
	let o = 33;
	let sawIdat = false;
	let animationFrames: number | undefined;
	let fctl = 0;
	for (;;) {
		need(b, o, 8, 'chunk-header');
		const len = be32(b, o);
		const type = ascii(b, o + 4, 4);
		if (len > 0x7fffffff) throw new Malformed(`chunk-length:${type}`);
		need(b, o, 12 + len, `chunk:${type}`);
		const d = o + 8;
		if (type === 'IEND') {
			o += 12;
			break;
		}
		if (type === 'IHDR') throw new Malformed('IHDR-repeated');
		if (type === 'IDAT') sawIdat = true;
		else if (type === 'acTL') {
			if (len < 8) throw new Malformed('acTL-short');
			animationFrames = be32(b, d);
		} else if (type === 'fcTL') fctl++;
		else if (type === 'eXIf') addExif(p, b.subarray(d, d + len), false);
		else if (type === 'tEXt' || type === 'zTXt') p.metadata.add('text');
		else if (type === 'iTXt') p.metadata.add(len >= 17 && ascii(b, d, 17) === 'XML:com.adobe.xmp' ? 'xmp' : 'text');
		else if (type === 'iCCP') p.metadata.add('icc');
		else if (!PNG_HARMLESS.has(type)) p.metadata.add('other');
		o += 12 + len;
	}
	if (!sawIdat) throw new Malformed('no-IDAT');
	if (animationFrames !== undefined) {
		if (animationFrames < 1 || fctl < animationFrames) throw new Malformed(`fcTL-${fctl}<acTL-${animationFrames}`);
		p.frames = animationFrames;
	}
	if (o < b.length) p.metadata.add('other'); // bytes after IEND
	return p;
}

const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;

function inspectJpeg(b: Uint8Array): Parsed {
	const p: Parsed = { format: 'jpeg', width: 0, height: 0, frames: 1, metadata: new Set() };
	let o = 2;
	let sawSof = false;
	let sawSos = false;
	let sawExif = false;
	for (;;) {
		need(b, o, 2, 'marker');
		if (b[o] !== 0xff) throw new Malformed(`bad-marker@${o}`);
		const m = b[o + 1] ?? 0;
		if (m === 0xff) {
			o++; // fill byte
			continue;
		}
		if (m === 0xd9) {
			if (!sawSos) throw new Malformed('no-SOS');
			o += 2;
			break;
		}
		if (m === 0xd8 || m === 0x00) throw new Malformed(`bad-marker@${o}`);
		if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
			o += 2;
			continue;
		}
		need(b, o + 2, 2, 'segment-length');
		const len = be16(b, o + 2);
		if (len < 2) throw new Malformed('segment-length');
		need(b, o + 2, len, `segment:${m.toString(16)}`);
		const d = o + 4;
		const n = len - 2;
		const starts = (s: string) => n >= s.length && ascii(b, d, s.length) === s;
		if (m === 0xe0) {
			if (!starts('JFIF\0') && !starts('JFXX\0')) p.metadata.add('other');
		} else if (m === 0xe1) {
			if (starts('Exif\0\0')) {
				// Only the first EXIF block decides the orientation (later ones are usually tool-added stubs).
				addExif(p, b.subarray(d + 6, d + n), !sawExif);
				sawExif = true;
			} else if (starts('http://ns.adobe.com/xap/1.0/\0') || starts('http://ns.adobe.com/xmp/extension/\0')) p.metadata.add('xmp');
			else p.metadata.add('other');
		} else if (m === 0xe2) p.metadata.add(starts('ICC_PROFILE\0') ? 'icc' : 'other');
		else if (m === 0xed) p.metadata.add('iptc');
		else if (m === 0xee) {
			if (!starts('Adobe')) p.metadata.add('other');
		} else if (m >= 0xe3 && m <= 0xef) p.metadata.add('other');
		else if (m === 0xfe) p.metadata.add('comment');
		else if (isSof(m)) {
			if (n < 6) throw new Malformed('SOF-short');
			const height = be16(b, d + 1);
			const width = be16(b, d + 3);
			if (sawSof && (width !== p.width || height !== p.height)) throw new Malformed('SOF-size-mismatch');
			p.width = width;
			p.height = height;
			sawSof = true;
		} else if (m === 0xda) {
			if (!sawSof) throw new Malformed('SOS-before-SOF');
			sawSos = true;
			// Skip the entropy-coded data up to the next real marker.
			let q = o + 2 + len;
			for (;;) {
				if (q + 1 >= b.length) throw new Malformed('no-EOI');
				if (b[q] === 0xff) {
					const next = b[q + 1] ?? 0;
					if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
						q += next === 0xff ? 1 : 2;
						continue;
					}
					break;
				}
				q++;
			}
			o = q;
			continue;
		}
		o += 2 + len;
	}
	if (o < b.length) p.metadata.add('other'); // bytes after EOI
	return p;
}

function inspectGif(b: Uint8Array): Parsed {
	need(b, 0, 13, 'header');
	const p: Parsed = { format: 'gif', width: le16(b, 6), height: le16(b, 8), frames: 0, metadata: new Set() };
	let o = 13;
	if ((b[10] ?? 0) & 0x80) o += 3 * (1 << (((b[10] ?? 0) & 7) + 1));
	const skipSubBlocks = (q: number) => {
		for (;;) {
			need(b, q, 1, 'sub-block');
			const size = b[q] ?? 0;
			if (size === 0) return q + 1;
			need(b, q, 1 + size, 'sub-block');
			q += 1 + size;
		}
	};
	for (;;) {
		need(b, o, 1, 'trailer');
		const t = b[o];
		if (t === 0x3b) {
			o++;
			break;
		}
		if (t === 0x21) {
			need(b, o, 2, 'extension');
			const label = b[o + 1];
			if (label === 0xff) {
				need(b, o, 14, 'application-extension');
				const id = ascii(b, o + 3, 11);
				if (id === 'XMP DataXMP') p.metadata.add('xmp');
				else if (id !== 'NETSCAPE2.0' && id !== 'ANIMEXTS1.0') p.metadata.add('other');
			} else if (label === 0xfe) p.metadata.add('comment');
			else if (label === 0x01) p.metadata.add('text');
			else if (label !== 0xf9) p.metadata.add('other');
			o = skipSubBlocks(o + 2);
		} else if (t === 0x2c) {
			need(b, o, 11, 'image-descriptor');
			const left = le16(b, o + 1), top = le16(b, o + 3), w = le16(b, o + 5), h = le16(b, o + 7);
			// A frame outside the logical screen can make the decoder enlarge the canvas past the size we checked.
			if (left + w > p.width || top + h > p.height) throw new Malformed('frame-outside-screen');
			const packed = b[o + 9] ?? 0;
			o += 10;
			if (packed & 0x80) o += 3 * (1 << ((packed & 7) + 1));
			o = skipSubBlocks(o + 1); // after the LZW minimum code size
			p.frames++;
		} else throw new Malformed(`bad-block@${o}`);
	}
	if (p.frames === 0) throw new Malformed('no-frames');
	if (o < b.length) p.metadata.add('other'); // bytes after the trailer
	return p;
}

function vp8Size(b: Uint8Array, d: number, len: number): [number, number] {
	if (len < 10 || b[d + 3] !== 0x9d || b[d + 4] !== 0x01 || b[d + 5] !== 0x2a) throw new Malformed('VP8-frame-tag');
	return [le16(b, d + 6) & 0x3fff, le16(b, d + 8) & 0x3fff];
}

function vp8lSize(b: Uint8Array, d: number, len: number): [number, number] {
	if (len < 5 || b[d] !== 0x2f) throw new Malformed('VP8L-signature');
	const bits = le32(b, d + 1);
	return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
}

function inspectWebp(b: Uint8Array): Parsed {
	const end = 8 + le32(b, 4);
	if (end > b.length) throw new Malformed('riff-size>file');
	const p: Parsed = { format: 'webp', width: 0, height: 0, frames: 1, metadata: new Set() };
	const chunks: { type: string; d: number; len: number }[] = [];
	let o = 12;
	while (o + 8 <= end) {
		const type = ascii(b, o, 4);
		const len = le32(b, o + 4);
		if (o + 8 + len > end) throw new Malformed(`chunk-overrun:${type}`);
		chunks.push({ type, d: o + 8, len });
		o += 8 + len + (len & 1);
	}
	if (o < end) throw new Malformed('riff-trailing');
	const first = chunks[0];
	if (!first) throw new Malformed('no-chunks');
	if (first.type === 'VP8 ' || first.type === 'VP8L') {
		// Simple format: exactly one image chunk.
		[p.width, p.height] = first.type === 'VP8 ' ? vp8Size(b, first.d, first.len) : vp8lSize(b, first.d, first.len);
		if (chunks.length > 1) p.metadata.add('other');
	} else if (first.type === 'VP8X') {
		if (first.len < 10) throw new Malformed('VP8X-short');
		const animated = ((b[first.d] ?? 0) & 0x02) !== 0;
		p.width = le24(b, first.d + 4) + 1;
		p.height = le24(b, first.d + 7) + 1;
		let images = 0;
		let anmf = 0;
		for (const c of chunks.slice(1)) {
			if (c.type === 'VP8 ' || c.type === 'VP8L') {
				if (animated) throw new Malformed('image-chunk-in-animation');
				const [w, h] = c.type === 'VP8 ' ? vp8Size(b, c.d, c.len) : vp8lSize(b, c.d, c.len);
				if (w !== p.width || h !== p.height) throw new Malformed('canvas-size-mismatch');
				images++;
			} else if (c.type === 'ANMF') {
				if (!animated) throw new Malformed('ANMF-without-animation-flag');
				if (c.len < 16) throw new Malformed('ANMF-short');
				const x = le24(b, c.d) * 2, y = le24(b, c.d + 3) * 2;
				const w = le24(b, c.d + 6) + 1, h = le24(b, c.d + 9) + 1;
				if (x + w > p.width || y + h > p.height) throw new Malformed('frame-outside-canvas');
				anmf++;
			} else if (c.type === 'EXIF') {
				const t = b.subarray(c.d, c.d + c.len);
				addExif(p, c.len >= 6 && ascii(t, 0, 6) === 'Exif\0\0' ? t.subarray(6) : t, false);
			} else if (c.type === 'XMP ') p.metadata.add('xmp');
			else if (c.type === 'ICCP') p.metadata.add('icc');
			else if (c.type !== 'ALPH' && c.type !== 'ANIM') p.metadata.add('other');
		}
		if (animated) {
			if (anmf === 0) throw new Malformed('animation-without-frames');
			p.frames = anmf;
		} else if (images !== 1) throw new Malformed(`image-chunks:${images}`);
	} else throw new Malformed(`first-chunk:${first.type}`);
	if (end < b.length) p.metadata.add('other'); // bytes after the RIFF container
	return p;
}

/**
 * Inspects an image for upload without decoding it: validates the container structure,
 * counts frames and lists the metadata it carries. The format comes from the bytes only.
 */
export function inspectImage(b: Uint8Array): ImageInspection {
	let parse: ((b: Uint8Array) => Parsed) | undefined;
	if (b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v)) parse = inspectPng;
	else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) parse = inspectJpeg;
	else if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) parse = inspectGif;
	else if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') parse = inspectWebp;
	if (!parse) return { kind: 'rejected', reason: looksLikeSvg(b) ? 'svg' : 'unknown-format' };
	let p: Parsed;
	try {
		p = parse(b);
	} catch (e) {
		if (e instanceof Malformed) return { kind: 'rejected', reason: 'malformed', detail: e.message };
		throw e;
	}
	if (p.width <= 0 || p.height <= 0) return { kind: 'rejected', reason: 'no-size' };
	const order: MetadataKind[] = ['exif', 'gps', 'xmp', 'iptc', 'text', 'comment', 'icc', 'other'];
	const result: ImageInspection = {
		kind: 'image',
		format: p.format,
		width: p.width,
		height: p.height,
		frames: p.frames,
		metadata: order.filter((k) => p.metadata.has(k)),
	};
	if (p.orientation !== undefined) result.orientation = p.orientation;
	return result;
}
