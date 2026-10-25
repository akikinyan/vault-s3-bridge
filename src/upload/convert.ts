// Decides the bytes an upload sends (design 4-2), re-encodes them to strip metadata (4-3) and names the
// method (4-4). Decoding and encoding live behind Encoder, so this module runs without a DOM.
import { createHash } from 'node:crypto';
import { type ImageFormat, inspectImage } from '../preview/imageInfo';
import type { Classification, UploadFormat } from '../settings/types';

/** Fixed for uploads, separate from preview.maxMegapixels. */
export const UPLOAD_MAX_PIXELS = 40_000_000;
export const JPEG_QUALITY = 0.92;

type OutputMime = 'image/png' | 'image/jpeg' | 'image/webp';

const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export interface DecodedImage {
	/** Size of the decoded bitmap, orientation applied. */
	readonly width: number;
	readonly height: number;
	encode(type: OutputMime, quality?: number): Promise<Uint8Array>;
	close(): void;
}

export interface Encoder {
	decode(bytes: Uint8Array, mime: string): Promise<DecodedImage>;
	/** process.versions.electron; part of the converter string. */
	readonly electronVersion: string;
}

export interface ConvertPolicy {
	classification: Classification;
	stripPrivate: boolean;
	webp: { enabled: boolean; quality: number };
	maxFileMB: number;
}

export type PrepareRejection =
	| 'unsupported'
	| 'too-large'
	| 'too-many-pixels'
	| 'animated'
	| 'decode-failed'
	/** The re-encoded output still carried something it must not, or was not what was asked for. */
	| 'strip-failed';

export type PreparedBytes =
	| { ok: true; bytes: Uint8Array; format: ImageFormat; converter: string; sentSha256: string; sourceFormat: ImageFormat; reencoded: boolean }
	| { ok: false; reason: PrepareRejection; detail?: string };

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Method {
	format: Exclude<ImageFormat, 'gif'>;
	mime: OutputMime;
	quality?: number;
	name: string;
}

const png = (): Method => ({ format: 'png', mime: 'image/png', name: 'png' });
const jpeg = (): Method => ({ format: 'jpeg', mime: 'image/jpeg', quality: JPEG_QUALITY, name: `jpeg@${JPEG_QUALITY}` });
const webp = (quality: number): Method => ({ format: 'webp', mime: 'image/webp', quality, name: `webp@${quality}` });

/** 4-2: re-encode to the same format (a still GIF becomes PNG), plus WebP when it is enabled. */
function methodsFor(source: ImageFormat, policy: ConvertPolicy): Method[] {
	const q = policy.webp.quality;
	const same = source === 'jpeg' ? jpeg() : source === 'webp' ? webp(q) : png();
	return policy.webp.enabled && same.format !== 'webp' ? [same, webp(q)] : [same];
}

const converterOf = (method: Method, electron: string) => `c1;${method.name};electron=${electron}`;
export const ORIGINAL_CONVERTER = 'c1;orig';

/** 4-3 step 4: the output is one frame of the asked format, the decoded size, with nothing but ICC left. */
function checkOutput(out: Uint8Array, method: Method, width: number, height: number): string | undefined {
	const r = inspectImage(out);
	if (r.kind !== 'image') return `output:${r.reason}`;
	if (r.format !== method.format) return `output-format:${r.format}`;
	if (r.frames !== 1) return 'output-frames';
	const left = r.metadata.filter((m) => m !== 'icc');
	if (left.length > 0) return `output-metadata:${left.join(',')}`;
	if (r.width !== width || r.height !== height) return 'output-size';
	return undefined;
}

async function encodeAll(source: Uint8Array, sourceFormat: ImageFormat, methods: readonly Method[], encoder: Encoder) {
	let image: DecodedImage;
	try {
		image = await encoder.decode(source, MIME[sourceFormat]);
	} catch {
		return { ok: false as const, reason: 'decode-failed' as const };
	}
	try {
		const outputs: { method: Method; bytes: Uint8Array }[] = [];
		for (const method of methods) {
			let bytes: Uint8Array;
			try {
				bytes = await image.encode(method.mime, method.quality);
			} catch {
				return { ok: false as const, reason: 'strip-failed' as const, detail: 'encode-error' };
			}
			const problem = checkOutput(bytes, method, image.width, image.height);
			// Never fall back to the original bytes: they still carry the metadata.
			if (problem) return { ok: false as const, reason: 'strip-failed' as const, detail: problem };
			outputs.push({ method, bytes });
		}
		return { ok: true as const, outputs };
	} finally {
		image.close();
	}
}

/** 4-2: what this connection sends for these source bytes. */
export async function prepareBytes(source: Uint8Array, policy: ConvertPolicy, encoder: Encoder): Promise<PreparedBytes> {
	const info = inspectImage(source);
	if (info.kind !== 'image') return { ok: false, reason: 'unsupported', detail: info.reason };
	if (source.length > policy.maxFileMB * 1024 * 1024) return { ok: false, reason: 'too-large' };
	// Rejected from the header alone, before anything is decoded.
	if (info.width * info.height > UPLOAD_MAX_PIXELS) return { ok: false, reason: 'too-many-pixels' };
	const strip = policy.classification === 'public' || policy.stripPrivate;
	if (!strip) {
		return { ok: true, bytes: source, format: info.format, converter: ORIGINAL_CONVERTER, sentSha256: sha256Hex(source), sourceFormat: info.format, reencoded: false };
	}
	if (info.frames > 1) return { ok: false, reason: 'animated' };
	const r = await encodeAll(source, info.format, methodsFor(info.format, policy), encoder);
	if (!r.ok) return r;
	// The smaller one; the same-format output wins a tie. Sent even when larger than the source (D6).
	const best = r.outputs.reduce((a, b) => (b.bytes.length < a.bytes.length ? b : a));
	return {
		ok: true,
		bytes: best.bytes,
		format: best.method.format,
		converter: converterOf(best.method, encoder.electronVersion),
		sentSha256: sha256Hex(best.bytes),
		sourceFormat: info.format,
		reencoded: true,
	};
}

/** Parses a converter string of version c1 back into its method; undefined when it is not one. */
function methodOf(converter: string, electron: string): Method | 'orig' | undefined {
	if (converter === ORIGINAL_CONVERTER) return 'orig';
	const m = /^c1;(png|jpeg@([0-9.]+)|webp@([0-9.]+));electron=(.+)$/.exec(converter);
	// 4-4: another Electron may encode differently, so its bytes are not rebuilt.
	if (!m || m[4] !== electron) return undefined;
	if (m[1] === 'png') return png();
	if (m[2] !== undefined) return Number(m[2]) === JPEG_QUALITY ? jpeg() : undefined;
	const q = Number(m[3]);
	return Number.isFinite(q) && q > 0 && q <= 1 ? webp(q) : undefined;
}

export interface RebuildRecord {
	sourceSha256: string;
	sentSha256: string;
	converter: string;
	format: UploadFormat;
}

/**
 * 6-5 step 2: the bytes of a recorded upload, made again from the source with the recorded method. Undefined when
 * the source changed, the converter cannot be repeated here, or the result is not the recorded sentSha256.
 */
export async function rebuildBytes(source: Uint8Array, record: RebuildRecord, encoder: Encoder): Promise<Uint8Array | undefined> {
	if (sha256Hex(source) !== record.sourceSha256) return undefined;
	const method = methodOf(record.converter, encoder.electronVersion);
	if (!method) return undefined;
	let bytes: Uint8Array;
	if (method === 'orig') bytes = source;
	else {
		if (method.format !== record.format) return undefined;
		const info = inspectImage(source);
		if (info.kind !== 'image' || info.frames > 1 || info.width * info.height > UPLOAD_MAX_PIXELS) return undefined;
		const r = await encodeAll(source, info.format, [method], encoder);
		if (!r.ok || !r.outputs[0]) return undefined;
		bytes = r.outputs[0].bytes;
	}
	return sha256Hex(bytes) === record.sentSha256 ? bytes : undefined;
}
