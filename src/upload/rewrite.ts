// Markdown for uploaded files and the replacement in the note (design 9, Phase 4 design 6). The note changes only if
// it still holds exactly the snapshot the job detected the references in (I7); otherwise the caller copies the Markdown.
import { encodeSegment, formatReference, parseReference, safeAltText } from '../reference/reference';
import type { UploadFormat } from '../settings/types';
import { validatePublicBaseUrl } from '../settings/validate';
import { type EmbedSyntax, type LinkSyntax, parseEmbeds } from './detect';
import { isImageFormat } from './fileType';

export type Target = { classification: 'public'; publicBaseUrl: string } | { classification: 'private'; alias: string };

/** `publicBaseUrl` without its trailing slashes, a slash, and the key encoded segment by segment, joined once. */
export function publicUrl(publicBaseUrl: string, key: string): string {
	if (validatePublicBaseUrl(publicBaseUrl)) throw new Error('invalid public base URL');
	return `${publicBaseUrl.replace(/\/+$/, '')}/${key.split('/').map(encodeSegment).join('/')}`;
}

export interface MarkdownInput {
	syntax: EmbedSyntax;
	target: Target;
	key: string;
	/** Name of the source file without its extension: the private default alt text. */
	fileBase: string;
	/** In a table, the generated `|` is written as `\|`. */
	inTable: boolean;
}

/** 9-3: what the user wrote is kept (through safeAltText); a public image without one gets an empty alt. */
export function altFor(input: Pick<MarkdownInput, 'syntax' | 'target' | 'fileBase'>): string {
	const { syntax, target } = input;
	const written = syntax.kind === 'wiki' ? syntax.alt : syntax.alt === '' ? undefined : syntax.alt;
	if (written !== undefined) return safeAltText(written);
	return target.classification === 'public' ? '' : safeAltText(input.fileBase);
}

export function buildMarkdown(input: MarkdownInput): string {
	return markdownFor({ shape: 'embed', alt: altFor(input), size: input.syntax.size, inTable: input.inTable }, input.target, input.key);
}

/** The kind of reference the note had. */
export type ReferenceKind = 'embed' | 'link';

/**
 * Design 6-2: what the generated Markdown is. A link stays a link; an image embed stays an embed; another file's
 * embed becomes a link in public storage (an external URL of it does not show as an embed, Step 1 O4).
 */
export function outputShape(kind: ReferenceKind, format: UploadFormat, classification: Target['classification']): ReferenceKind {
	if (kind === 'link' || isImageFormat(format)) return kind;
	return classification === 'public' ? 'link' : 'embed';
}

/** Characters with a meaning inside a line of Markdown (design 6-2). */
const LINK_TEXT_SPECIAL = /[\\`*_[\]<>!|~=$%#&^]/g;

// eslint-disable-next-line no-control-regex -- control characters are exactly what this matches
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Design 6-2: plain text as the text of a link: control characters become spaces, specials get a backslash. */
export function escapeLinkText(text: string): string {
	return text.replace(CONTROL, ' ').replace(LINK_TEXT_SPECIAL, (c) => `\\${c}`);
}

/** The text a reader sees for an escaped link text: a backslash before ASCII punctuation is dropped. */
export function unescapeLinkText(text: string): string {
	return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

export type ReferenceSource = { kind: 'embed'; syntax: EmbedSyntax } | { kind: 'link'; syntax: LinkSyntax };

export interface ReferenceInput {
	source: ReferenceSource;
	format: UploadFormat;
	target: Target;
	key: string;
	/** The source file's name with its extension. */
	fileName: string;
	/** The source file's name without its extension (an image's private default alt, as in Phase 3). */
	fileBase: string;
	inTable: boolean;
}

/** What a record keeps of one occurrence (1-2): the text inside the brackets as written, never escaped again. */
export interface ReferenceParts {
	shape: ReferenceKind;
	alt: string;
	size?: string;
	inTable: boolean;
}

export type BuiltReference = { ok: true; parts: ReferenceParts; markdown: string } | { ok: false; reason: 'escaped-text' | 'markdown-check' };

/** Design 6-2 and 6-3: the Markdown for one reference, checked by reading it back. */
export function buildReference(input: ReferenceInput): BuiltReference {
	const { source, target } = input;
	const shape = outputShape(source.kind, input.format, target.classification);
	let alt: string;
	/** Escaped plain text: what it must read as. */
	let plain: string | undefined;
	let size: string | undefined;
	if (source.kind === 'embed' && isImageFormat(input.format)) {
		alt = altFor({ syntax: source.syntax, target, fileBase: input.fileBase });
		size = source.syntax.size;
	} else if (source.kind === 'embed') {
		const s = source.syntax;
		const written = s.kind === 'wiki' ? s.alt : s.alt === '' ? undefined : s.alt;
		if (shape === 'embed') {
			alt = safeAltText(written ?? input.fileName);
			size = s.size;
		} else {
			// The alt of `![t](p)` is Markdown: a backslash in it would show once escaped again.
			if (s.kind === 'markdown' && written?.includes('\\')) return { ok: false, reason: 'escaped-text' };
			plain = written ?? input.fileName;
			alt = escapeLinkText(plain);
		}
	} else if (source.syntax.kind === 'wiki') {
		plain = source.syntax.text ?? input.fileName;
		alt = escapeLinkText(plain);
	} else {
		alt = source.syntax.text;
	}
	const parts: ReferenceParts = { shape, alt, ...(size === undefined ? {} : { size }), inTable: input.inTable };
	const markdown = markdownFor(parts, target, input.key);
	if (!verifyMarkdown(markdown, target, input.key, parts) || (plain !== undefined && unescapeLinkText(alt) !== plain.replace(CONTROL, ' '))) {
		return { ok: false, reason: 'markdown-check' };
	}
	return { ok: true, parts, markdown };
}

/** From the parts as stored in a resume record's occurrence (7-1, 6-4): nothing is escaped again. */
export function markdownFor(o: ReferenceParts, target: Target, key: string): string {
	const url = target.classification === 'public' ? publicUrl(target.publicBaseUrl, key) : formatReference(target.alias, key);
	if (o.shape === 'link') return `[${o.alt}](${url})`;
	const bar = o.inTable ? '\\|' : '|';
	return `![${o.alt}${o.size ? `${bar}${o.size}` : ''}](${url})`;
}

/** A `|` without a backslash before it (a backslash escapes the next character only). */
function hasBarePipe(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\\') i++;
		else if (text[i] === '|') return true;
	}
	return false;
}

/**
 * 9-3 and design 6-3: the generated Markdown is exactly one embed or link of the expected shape, read with schemes
 * counted; the key comes back out of its URL or reference; in a table it has no bare `|`.
 */
export function verifyMarkdown(markdown: string, target: Target, key: string, expect: Pick<ReferenceParts, 'shape' | 'inTable'> = { shape: 'embed', inTable: false }): boolean {
	const parsed = parseEmbeds(markdown, { countSchemeReferences: true });
	if (!parsed.ok) return false;
	const found = expect.shape === 'embed' ? parsed.embeds : parsed.links;
	if (parsed.embeds.length + parsed.links.length !== 1 || found[0]?.offset !== 0 || found[0].original !== markdown || found[0].inComment) return false;
	if (expect.inTable && hasBarePipe(markdown)) return false;
	const m = /\]\(([^()\s]+)\)$/.exec(markdown);
	if (!m) return false;
	const url = m[1]!;
	if (target.classification === 'private') {
		const r = parseReference(url);
		return r.ok && r.value.alias === target.alias && r.value.key === key;
	}
	const base = `${target.publicBaseUrl.replace(/\/+$/, '')}/`;
	if (!url.startsWith(base)) return false;
	try {
		return url.slice(base.length).split('/').map(decodeURIComponent).join('/') === key;
	} catch {
		return false;
	}
}

export interface Replacement {
	/** Offset in the snapshot (as stored, CRLF kept). */
	offset: number;
	length: number;
	text: string;
}

/** 9-1: replaces from the end; everything outside the ranges must stay exactly as it was. */
export function replaceRanges(snapshot: string, replacements: readonly Replacement[]): string {
	const sorted = [...replacements].sort((a, b) => a.offset - b.offset);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i]!.offset < sorted[i - 1]!.offset + sorted[i - 1]!.length) throw new Error('overlapping replacements');
	}
	let next = snapshot;
	for (const r of [...sorted].reverse()) next = next.slice(0, r.offset) + r.text + next.slice(r.offset + r.length);
	const outside = (text: string, shifted: boolean) => {
		let out = '';
		let p = 0;
		let shift = 0;
		for (const r of sorted) {
			const start = r.offset + (shifted ? shift : 0);
			out += text.slice(p, start);
			p = start + (shifted ? r.text.length : r.length);
			shift += r.text.length - r.length;
		}
		return out + text.slice(p);
	};
	if (outside(snapshot, false) !== outside(next, true)) throw new Error('text outside the replacements changed');
	return next;
}

const toLf = (s: string) => s.replace(/\r\n/g, '\n');

/** The editor holds LF text: an offset in a CRLF snapshot moves back by the CRs before it. */
export function lfOffset(snapshot: string, offset: number): number {
	let crs = 0;
	for (let i = snapshot.indexOf('\r'); i >= 0 && i < offset; i = snapshot.indexOf('\r', i + 1)) crs++;
	return offset - crs;
}

export interface EditorLike {
	getValue(): string;
	offsetToPos(offset: number): { line: number; ch: number };
	transaction(tx: { changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] }): void;
}

/** What 9-2 needs to know about the note when the job applies the replacements. */
export interface NoteAccess {
	/** Loaded editors that show the note now (any tab position). */
	openEditors(): EditorLike[];
	/** The note was open in an editor when the job started. */
	wasOpenAtStart: boolean;
	exists(): boolean;
	/** vault.process: the returned text is written only if it differs. */
	process(fn: (data: string) => string): Promise<string>;
	read(): Promise<string>;
}

export type ApplyResult =
	| { applied: true; via: 'editor' | 'file'; verified: boolean }
	| { applied: false; reason: 'closed' | 'deleted' | 'changed' }
	/** `allowed` said no at the moment of writing. */
	| { applied: false; reason: 'blocked' };

/**
 * 9-2: one editor transaction (in the same synchronous step as the check) when the note is open, otherwise
 * vault.process that writes only over the exact snapshot. If neither applies, nothing is replaced at all.
 * `allowed` is asked in that same synchronous step, so a condition that changed while waiting is seen.
 */
export async function applyToNote(note: NoteAccess, snapshot: string, replacements: readonly Replacement[], allowed: () => boolean = () => true): Promise<ApplyResult> {
	const next = replaceRanges(snapshot, replacements);
	const editor = note.openEditors()[0];
	if (editor) {
		if (editor.getValue() !== toLf(snapshot)) return { applied: false, reason: 'changed' };
		if (!allowed()) return { applied: false, reason: 'blocked' };
		const changes = [...replacements]
			.sort((a, b) => a.offset - b.offset)
			.map((r) => ({
				from: editor.offsetToPos(lfOffset(snapshot, r.offset)),
				to: editor.offsetToPos(lfOffset(snapshot, r.offset + r.length)),
				text: r.text,
			}));
		editor.transaction({ changes });
		return { applied: true, via: 'editor', verified: editor.getValue() === toLf(next) };
	}
	if (note.wasOpenAtStart) return { applied: false, reason: 'closed' };
	if (!note.exists()) return { applied: false, reason: 'deleted' };
	let matched = false;
	let blocked = false;
	await note.process((data) => {
		matched = data === snapshot;
		blocked = matched && !allowed();
		return matched && !blocked ? next : data;
	});
	if (!matched) return { applied: false, reason: 'changed' };
	if (blocked) return { applied: false, reason: 'blocked' };
	return { applied: true, via: 'file', verified: (await note.read()) === next };
}
