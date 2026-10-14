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
