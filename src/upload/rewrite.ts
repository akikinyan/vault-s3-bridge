// Markdown for uploaded images and the replacement in the note (design 9). The note changes only if it still
// holds exactly the snapshot the job detected the embeds in (I7); otherwise the caller copies the Markdown.
import { encodeSegment, formatReference, parseReference, safeAltText } from '../reference/reference';
import { validatePublicBaseUrl } from '../settings/validate';
import { type EmbedSyntax, markdownImageLength } from './detect';

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
	const { syntax, target } = input;
	const alt = altFor(input);
	const url = target.classification === 'public' ? publicUrl(target.publicBaseUrl, input.key) : formatReference(target.alias, input.key);
	const bar = input.inTable ? '\\|' : '|';
	return `![${alt}${syntax.size ? `${bar}${syntax.size}` : ''}](${url})`;
}

/** 9-3 check: the generated Markdown is exactly one image, and the key comes back out of its URL or reference. */
export function verifyMarkdown(markdown: string, target: Target, key: string): boolean {
	if (markdownImageLength(markdown, 0) !== markdown.length || !markdown.startsWith('![')) return false;
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
	| { applied: false; reason: 'closed' | 'deleted' | 'changed' };

/**
 * 9-2: one editor transaction (in the same synchronous step as the check) when the note is open, otherwise
 * vault.process that writes only over the exact snapshot. If neither applies, nothing is replaced at all.
 */
export async function applyToNote(note: NoteAccess, snapshot: string, replacements: readonly Replacement[]): Promise<ApplyResult> {
	const next = replaceRanges(snapshot, replacements);
	const editor = note.openEditors()[0];
	if (editor) {
		if (editor.getValue() !== toLf(snapshot)) return { applied: false, reason: 'changed' };
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
	await note.process((data) => {
		matched = data === snapshot;
		return matched ? next : data;
	});
	if (!matched) return { applied: false, reason: 'changed' };
	return { applied: true, via: 'file', verified: (await note.read()) === next };
}
