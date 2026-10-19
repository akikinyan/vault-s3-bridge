// Format of an attachment from its bytes (design 2). The rules follow WHATWG MIME Sniffing 5.2, 7.1 and 7.2, made
// stricter: markup at the start (after a UTF-8 BOM and whitespace bytes) is active content whatever the tag, the
// whole file is checked for text, several signatures at once are ambiguous, and the verdict must fit the extension.
// JavaScript is judged by extension only: text is served as text/plain, which a browser does not run.
import { detectImage, type ImageFormat } from '../preview/imageInfo';

export type { ImageFormat };
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const satisfies readonly ImageFormat[];
export const FILE_FORMATS = [...IMAGE_FORMATS, 'pdf', 'svg', 'text', 'docx', 'xlsx', 'pptx', 'zip', 'audio', 'video', 'active', 'other'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];

export type FileKind = 'image' | 'pdf' | 'svg' | 'text' | 'office' | 'zip' | 'audio' | 'video' | 'active' | 'ambiguous';
/** allow: sent as is; confirm: needs the per-file confirmation (I15); image: the Phase 3 path; reject: never public (I14). */
export type PublicUse = 'allow' | 'confirm' | 'image' | 'reject';

export interface FileVerdict {
	kind: FileKind;
	format: FileFormat;
	/** The fixed Content-Type this file is put with (I14 (d)). */
	contentType: string;
	publicUse: PublicUse;
	/** For tests and logs only, never for messages shown to the user. */
	reasons: string[];
}

/** Content-Types the plugin puts. Only these strings are ever written (I14 (d)). */
export const TEXT_CONTENT_TYPE = 'text/plain; charset=utf-8';
export const OCTET_STREAM = 'application/octet-stream';
const IMAGE_CONTENT_TYPE: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const OFFICE_CONTENT_TYPE = {
	docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
} as const;
const AUDIO: Record<string, string> = { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', flac: 'audio/flac' };
const VIDEO: Record<string, string> = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', ogv: 'video/ogg', webm: 'video/webm' };

const ACTIVE_EXT = new Set(['html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt', 'js', 'mjs', 'cjs', 'css', 'swf', 'mht', 'mhtml']);
const TEXT_EXT = new Set(['txt', 'text', 'log', 'csv', 'tsv', 'json']);
const IMAGE_EXT: Record<ImageFormat, readonly string[]> = { png: ['png'], jpeg: ['jpg', 'jpeg'], webp: ['webp'], gif: ['gif'] };

/** Container signatures and the extensions each may carry. */
type AvSignature = 'ftyp' | 'mp3' | 'wave' | 'avi' | 'ogg' | 'flac' | 'ebml';
const AV_EXT: Record<AvSignature, readonly string[]> = {
	ftyp: ['mp4', 'm4a', 'm4v', 'mov'],
	mp3: ['mp3'],
	wave: ['wav'],
	avi: [],
	ogg: ['ogg', 'oga', 'ogv', 'opus'],
	flac: ['flac'],
	ebml: ['webm'],
};

/** Design 2-3 / 7-3: limits for reading a ZIP central directory. Over them the file is ambiguous. */
export const ZIP_MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
export const ZIP_MAX_ENTRIES = 20_000;

const WS = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const isBinaryByte = (c: number) => c <= 0x08 || c === 0x0b || (c >= 0x0e && c <= 0x1a) || (c >= 0x1c && c <= 0x1f);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
const le16 = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const le32 = (b: Uint8Array, i: number) => (le16(b, i) | (le16(b, i + 2) << 16)) >>> 0;

function indexOf(b: Uint8Array, s: string, from: number, to: number): number {
	const n = s.length;
	const end = Math.min(to, b.length);
	outer: for (let i = from; i + n <= end; i++) {
		for (let j = 0; j < n; j++) if (b[i + j] !== s.charCodeAt(j)) continue outer;
		return i;
	}
	return -1;
}

/** Offset of the first byte after an optional UTF-8 BOM and whitespace bytes. */
function contentStart(b: Uint8Array): number {
	let i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
	while (i < b.length && WS.has(b[i]!)) i++;
	return i;
}

/** Markup at the start: '<' followed by a letter, '!' or '?'. Any tag counts (design 2-2, decision 2). */
function markupAt(b: Uint8Array): number | undefined {
	const i = contentStart(b);
	if (b[i] !== 0x3c) return undefined;
	const c = b[i + 1] ?? 0;
	const letter = (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
	return letter || c === 0x21 || c === 0x3f ? i : undefined;
}

/** The markup starts an SVG document: `<svg`, or an XML declaration, comments or a DOCTYPE and then `<svg`. */
function isSvgMarkup(b: Uint8Array, at: number): boolean {
	const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(at, at + 4096)).toLowerCase();
	let rest = head;
	for (;;) {
		rest = rest.trimStart();
		if (/^<svg[\s/>]/.test(rest)) return true;
		const skip = /^(<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!doctype[^>]*>)/.exec(rest);
		if (!skip) return false;
		rest = rest.slice(skip[0].length);
	}
}

interface ZipInfo {
	clean: boolean;
	problems: string[];
	names: string[];
}

/** ZIP from the tail: end-of-central-directory record (comment up to 64 KiB), then the central directory. Never inflates. */
function zipFromTail(b: Uint8Array): ZipInfo | undefined {
	const from = Math.max(0, b.length - (22 + 0xffff));
	let eocd = -1;
	for (let i = b.length - 22; i >= from; i--) {
		if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return undefined;
	const problems: string[] = [];
	const entries = le16(b, eocd + 10);
	const cdSize = le32(b, eocd + 12);
	const cdOffset = le32(b, eocd + 16);
	const commentLen = le16(b, eocd + 20);
	if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) problems.push('zip64');
	if (entries > ZIP_MAX_ENTRIES || cdSize > ZIP_MAX_DIRECTORY_BYTES) problems.push('zip-over-limit');
	if (eocd + 22 + commentLen !== b.length) problems.push('data-after-zip');
	if (cdOffset + cdSize !== eocd) problems.push('data-before-zip-or-bad-offset');
	if (ascii(b, 0, 4) !== 'PK\x03\x04') problems.push('not-starting-with-local-header');
	const names: string[] = [];
	if (problems.length === 0) {
		const decoder = new TextDecoder();
		let p = eocd - cdSize;
		for (let n = 0; n < entries && p + 46 <= eocd; n++) {
			if (le32(b, p) !== 0x02014b50) {
				problems.push('bad-central-directory');
				break;
			}
			const nameLen = le16(b, p + 28);
			names.push(decoder.decode(b.subarray(p + 46, p + 46 + nameLen)));
			p += 46 + nameLen + le16(b, p + 30) + le16(b, p + 32);
		}
		if (names.length !== entries) problems.push('entry-count-mismatch');
	}
	return { clean: problems.length === 0, problems, names };
}

function officeFormat(names: readonly string[]): 'docx' | 'xlsx' | 'pptx' | undefined {
	if (!names.includes('[Content_Types].xml')) return undefined;
	const found = new Set<'docx' | 'xlsx' | 'pptx'>();
	for (const n of names) {
		if (n.startsWith('word/')) found.add('docx');
		else if (n.startsWith('xl/')) found.add('xlsx');
		else if (n.startsWith('ppt/')) found.add('pptx');
	}
	return found.size === 1 ? [...found][0] : undefined;
}

/** MPEG audio frame sync alone is weak (it also matches FF FE): only trusted with the mp3 extension (decision 5). */
function avSignature(b: Uint8Array, ext: string): AvSignature | undefined {
	if (ascii(b, 4, 4) === 'ftyp') {
		const major = ascii(b, 8, 4);
		return ['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis'].includes(major) ? undefined : 'ftyp';
	}
	if (ascii(b, 0, 3) === 'ID3') return 'mp3';
	if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return 'wave';
	if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'AVI ') return 'avi';
	if (ascii(b, 0, 4) === 'OggS') return 'ogg';
	if (ascii(b, 0, 4) === 'fLaC') return 'flac';
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'ebml';
	const isBom = (b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff);
	if (ext === 'mp3' && !isBom && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0 && ((b[1] ?? 0) & 0x06) !== 0) return 'mp3';
	return undefined;
}

/** Text: no binary data bytes (7.2) anywhere and valid UTF-8 throughout. */
export function isUtf8Text(b: Uint8Array): boolean {
	for (const c of b) if (isBinaryByte(c)) return false;
	try {
		new TextDecoder('utf-8', { fatal: true }).decode(b);
		return true;
	} catch {
		return false;
	}
}

/** True when the first bytes hold a binary data byte (7.2). Used to skip files that cannot hold links. */
export function looksBinary(head: Uint8Array): boolean {
	for (const c of head) if (isBinaryByte(c)) return true;
	return false;
}

type Signature = 'active' | 'svg' | 'pdf' | 'zip' | 'image' | AvSignature;

interface Scan {
	signatures: Set<Signature>;
	ambiguous: string[];
	reasons: string[];
	office?: 'docx' | 'xlsx' | 'pptx';
	image?: ImageFormat;
}

function scan(b: Uint8Array, ext: string): Scan {
	const signatures = new Set<Signature>();
	const ambiguous: string[] = [];
	const reasons: string[] = [];
	const s: Scan = { signatures, ambiguous, reasons };
	const markup = markupAt(b);
	if (markup !== undefined) {
		signatures.add(isSvgMarkup(b, markup) ? 'svg' : 'active');
		reasons.push('markup-start');
	}
	const pdfAt = indexOf(b, '%PDF-', 0, 1024);
	if (pdfAt === 0) signatures.add('pdf');
	else if (pdfAt > 0) ambiguous.push('pdf-header-late');
	const zip = zipFromTail(b);
	if (zip) {
		signatures.add('zip');
		if (zip.clean) s.office = officeFormat(zip.names);
		else ambiguous.push(...zip.problems.map((p) => `zip:${p}`));
	}
	const img = detectImage(b);
	if (img.kind === 'image') {
		signatures.add('image');
		s.image = img.format;
	}
	const av = avSignature(b, ext);
	if (av) signatures.add(av);
	if (b[0] === 0x1f && b[1] === 0x8b) ambiguous.push('gzip');
	if ((b[0] === 0xfe && b[1] === 0xff) || (b[0] === 0xff && b[1] === 0xfe)) ambiguous.push('utf16-bom');
	if (ascii(b, 0, 11) === '%!PS-Adobe-') ambiguous.push('postscript');
	return s;
}

const verdict = (kind: FileKind, format: FileFormat, contentType: string, publicUse: PublicUse, reasons: string[]): FileVerdict => ({ kind, format, contentType, publicUse, reasons });
const active = (reasons: string[]) => verdict('active', 'active', OCTET_STREAM, 'reject', reasons);
const ambiguous = (reasons: string[]) => verdict('ambiguous', 'other', OCTET_STREAM, 'reject', reasons);

/**
 * Design 2-2. `extension` is the source file's extension, lowercase, without the dot ('' when it has none).
 * Image bytes never reach this in an upload: they take the Phase 3 path (design 3-1).
 */
export function classifyFile(b: Uint8Array, extension: string): FileVerdict {
	const ext = extension.normalize('NFC').toLowerCase();
	const s = scan(b, ext);
	const reasons = [...s.reasons];
	const sigs = [...s.signatures];

	// (a) Active extensions are active whatever the content; an .svg holding an SVG document is kept as svg
	// for the private preview, and is still rejected for public storage.
	if (ACTIVE_EXT.has(ext)) {
		if (ext === 'svg' && sigs.length === 1 && sigs[0] === 'svg' && s.ambiguous.length === 0 && isUtf8Text(b)) {
			return verdict('svg', 'svg', 'image/svg+xml', 'reject', [...reasons, 'svg']);
		}
		return active([...reasons, `active-extension:${ext}`]);
	}
	// (c) Several signatures at once (a polyglot) are ambiguous; (b) markup at the start, SVG included, is active.
	const markup = s.signatures.has('active') || s.signatures.has('svg');
	if (sigs.length > 1) return ambiguous([...reasons, `multiple:${sigs.join('+')}`]);
	if (markup) return active(reasons);
	if (s.ambiguous.length > 0) return ambiguous([...reasons, ...s.ambiguous]);

	const sig = sigs[0];
	if (sig === undefined) {
		// Decision 1: text whose start is not markup is text, even with HTML later (served as text/plain).
		if (!isUtf8Text(b)) return ambiguous([...reasons, 'not-text']);
		// Decision 4: no extension, no basis to call it text. Decision 3: an unparsable .json is still text.
		if (!TEXT_EXT.has(ext)) return ambiguous([...reasons, `extension-mismatch:text:${ext || '(none)'}`]);
		return verdict('text', 'text', TEXT_CONTENT_TYPE, 'allow', reasons);
	}
	const mismatch = (what: string) => ambiguous([...reasons, `extension-mismatch:${what}:${ext || '(none)'}`]);
	switch (sig) {
		case 'pdf':
			return ext === 'pdf' ? verdict('pdf', 'pdf', 'application/pdf', 'confirm', reasons) : mismatch('pdf');
		case 'zip':
			if (s.office) return ext === s.office || ext === 'zip' ? verdict('office', s.office, OFFICE_CONTENT_TYPE[s.office], 'confirm', reasons) : mismatch(s.office);
			return ext === 'zip' ? verdict('zip', 'zip', 'application/zip', 'confirm', reasons) : mismatch('zip');
		case 'image': {
			const f = s.image!;
			return IMAGE_EXT[f].includes(ext) ? verdict('image', f, IMAGE_CONTENT_TYPE[f], 'image', reasons) : mismatch(f);
		}
		case 'active':
		case 'svg':
			return active(reasons);
		default: {
			if (!AV_EXT[sig].includes(ext)) return mismatch(sig);
			const audio = AUDIO[ext];
			if (audio) return verdict('audio', 'audio', audio, 'confirm', reasons);
			const video = VIDEO[ext];
			return video ? verdict('video', 'video', video, 'confirm', reasons) : mismatch(sig);
		}
	}
}

/** Design 3-7: what may be done with a record of this format in public storage, without its bytes. */
export function publicUseOf(format: FileFormat): PublicUse {
	switch (format) {
		case 'png':
		case 'jpeg':
		case 'webp':
		case 'gif':
			return 'image';
		case 'text':
			return 'allow';
		case 'pdf':
		case 'docx':
		case 'xlsx':
		case 'pptx':
		case 'zip':
		case 'audio':
		case 'video':
			return 'confirm';
		case 'svg':
		case 'active':
		case 'other':
			return 'reject';
	}
}

/** Content-Type of an image format (Phase 3's table). */
export function imageContentType(format: ImageFormat): string {
	return IMAGE_CONTENT_TYPE[format];
}

export function isImageFormat(format: FileFormat): format is ImageFormat {
	return (IMAGE_FORMATS as readonly string[]).includes(format);
}

/** Lowercase extension of a file name, without the dot; '' when there is none (a leading dot does not count). */
export function extensionOf(name: string): string {
	const base = name.slice(name.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1).normalize('NFC').toLowerCase() : '';
}

export type ContentKind = 'image' | 'pdf' | 'svg' | 'text' | 'other';

/**
 * Design 2-5: how a private preview may show these bytes, without looking at the extension. Safety comes from the
 * way each kind is shown (I17), not from this verdict, which is never used to decide what may be public.
 */
export function classifyContent(b: Uint8Array): ContentKind {
	const s = scan(b, '');
	const sigs = [...s.signatures];
	if (s.ambiguous.length > 0 || sigs.length > 1) return 'other';
	switch (sigs[0]) {
		case undefined:
			return isUtf8Text(b) ? 'text' : 'other';
		case 'svg':
			return isUtf8Text(b) ? 'svg' : 'other';
		case 'pdf':
			return 'pdf';
		case 'image':
			return 'image';
		default:
			return 'other';
	}
}
