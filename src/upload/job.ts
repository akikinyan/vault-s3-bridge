// The upload job (design 10): one note, one connection, at most one job at a time. Preparing reads and converts
// but writes nothing (the preview command stops there, I13); sending goes group by group through the uploader;
// the note changes only over the exact snapshot, otherwise the Markdown is copied (I7). Obsidian stays outside:
// everything it provides is passed in.
import { ARCHIVE_FOLDER } from '../archive/paths';
import type { S3Client } from '@aws-sdk/client-s3';
import { stableStringify } from '../settings/migrate';
import { connectionState, connectionTarget } from '../settings/registry';
import type { SettingsStore, StoreChange } from '../settings/store';
import type { PluginSettings, StorageConnection, UploadFormat } from '../settings/types';
import type { TargetKey } from '../storage/target';
import type { DeepReadonly } from '../util/deepReadonly';
import { type Encoder, ORIGINAL_CONVERTER, type PrepareRejection, prepareBytes, rebuildBytes, sha256Hex } from './convert';
import { detectImage } from '../preview/imageInfo';
import { classifyFile, extensionOf, imageContentType, isImageFormat, publicUseOf } from './fileType';
import { type Detection, type EmbedSyntax, type FoundEmbed, type LinkSyntax, parseEmbedSyntax, parseLinkSyntax, type SyntaxRejection } from './detect';
import { buildKey, checkTemplate } from './key';
import type { NewPendingItem, PendingItem, PendingStore } from './pending';
import { compareHead, headCommand } from './s3';
import { applyToNote, type ApplyResult, buildReference, markdownFor, type NoteAccess, outputShape, type ReferenceParts, type ReferenceSource, type Target, verifyMarkdown } from './rewrite';
import { type ItemResult, type RebuildRefusal, resumeGroup, sendGroup, type UploaderDeps } from './uploader';
import { validatePublicBaseUrl } from '../settings/validate';

const MB = 1024 * 1024;

/** I8 / 7-6: jobs, resumes, takeovers and discards all take this one lock. */
export class JobLock {
	private held = false;

	get busy(): boolean {
		return this.held;
	}

	/** A release function, or undefined when another operation holds the lock. */
	acquire(): (() => void) | undefined {
		if (this.held) return undefined;
		this.held = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.held = false;
		};
	}
}

// --- preparing (no side effects) ---------------------------------------------

export type SkipReason =
	| 'comment'
	| SyntaxRejection
	/** A `|` in a table row inside a quote, callout or list: whether it is a cell cannot be checked (D11). */
	| 'nested-table'
	| 'not-found'
	| 'read-failed'
	| PrepareRejection
	| 'private-recorded'
	/** Design 3-1: a format public storage never serves (I14 (a), (b)). */
	| 'active-content'
	/** Design 3-1: a format that cannot be told apart for public storage (I14 (c)). */
	| 'ambiguous-format'
	| 'key-error'
	| 'markdown-check'
	/** Design 5-4: the file is in the archive folder; it has to be moved back first. */
	| 'in-archive'
	/** Design 5-3: a reference-style definition `[id]: p` of an attachment; it is not rewritten (D18). */
	| 'reference-style'
	/** Design 6-2: the alt text of `![t](p)` holds Markdown escapes, which a link text would show. */
	| 'escaped-text'
	/** A link that holds another embed or link, or is held in one: replacing one would change the other. */
	| 'overlapping';

export interface SourceFile {
	path: string;
	/** File name without its extension: the private default alt text. */
	basename: string;
	size: number;
	read(): Promise<Uint8Array>;
}

export interface JobTarget {
	connectionId: string;
	alias: string;
	classification: 'public' | 'private';
	target: TargetKey;
	publicBaseUrl?: string;
	keyTemplate: string;
}

export interface PlannedOccurrence {
	offset: number;
	original: string;
	inTable: boolean;
	source: ReferenceSource;
	/** What the record keeps (6-4): the same with any key. */
	parts: ReferenceParts;
	/** With the group's key as prepared; rebuilt with the final key before applying. */
	markdown: string;
}

export interface PlannedFile {
	itemId: string;
	sourcePath: string;
	basename: string;
	/** The name with its extension (6-2: the default text of a link, and of another file's private alt). */
	fileName: string;
	sourceSha256: string;
	sourceSize: number;
	occurrences: PlannedOccurrence[];
}

export interface PlannedGroup {
	groupId: string;
	/** The candidate from the history, or the first file's prepared key. */
	key: string;
	preparedKey: string;
	phase: 'candidate' | 'prepared';
	sentSha256: string;
	format: UploadFormat;
	/** The fixed Content-Type every file of the group is put with (fileType.ts). */
	contentType: string;
	converter: string;
	/** An image's prepared bytes. Other files keep none: they are read again right before the Put (3-3). */
	bytes: Uint8Array | undefined;
	/** Bytes sent: kept for the screen where the bytes are not held. */
	size: number;
	reencoded: boolean;
	files: PlannedFile[];
}

/** Over maxJobMB: shown on the screen, sent by a later run. Its bytes are not kept (2-2: what is prepared stays within the limit). */
export type DeferredGroup = Omit<PlannedGroup, 'bytes'>;

export interface SkippedEmbed {
	offset: number;
	original: string;
	reason: SkipReason;
	detail?: string;
}

export interface JobPlan {
	jobId: string;
	notePath: string;
	snapshot: string;
	target: JobTarget;
	groups: PlannedGroup[];
	/** Over maxJobMB: left for the next run. */
	deferred: DeferredGroup[];
	skipped: SkippedEmbed[];
}

export type PrepareFailure = 'template' | 'public-url';

export interface PrepareInput {
	notePath: string;
	snapshot: string;
	embeds: readonly FoundEmbed[];
	/** Design 5-4: used only with PrepareDeps.attachments. */
	links?: readonly FoundEmbed[];
	/** Offsets of reference-style links and definitions (5-3); used only with PrepareDeps.attachments. */
	references?: readonly number[];
	connection: DeepReadonly<StorageConnection>;
	settings: DeepReadonly<PluginSettings>;
}

export interface PrepareDeps {
	/** metadataCache.getFirstLinkpathDest from the note; undefined unless it is a file in the vault. */
	resolveLink(linkpath: string): SourceFile | undefined;
	encoder: Encoder;
	/**
	 * Phase 4: links (5-4) and files other than PNG, JPEG, WebP and GIF (3-1 step 3). The plugin turns it on; when
	 * off, only embeds of images are prepared, as in Phase 3.
	 */
	attachments?: boolean;
	now(): Date;
	newId(): string;
}

/** 8-1 step 1: notes in an excluded folder (or below it) are never uploaded from. */
export function inExcludedFolder(notePath: string, folders: readonly string[]): boolean {
	return folders.some((f) => {
		const dir = f.replace(/^\/+|\/+$/g, '');
		return dir === '' ? false : notePath === dir || notePath.startsWith(`${dir}/`);
	});
}

export function jobTarget(c: DeepReadonly<StorageConnection>): JobTarget {
	return {
		connectionId: c.id,
		alias: c.alias,
		classification: c.classification,
		target: connectionTarget(c),
		...(c.publicBaseUrl === undefined ? {} : { publicBaseUrl: c.publicBaseUrl }),
		keyTemplate: c.keyTemplate,
	};
}

function rewriteTarget(t: JobTarget): Target {
	return t.classification === 'public' ? { classification: 'public', publicBaseUrl: t.publicBaseUrl ?? '' } : { classification: 'private', alias: t.alias };
}

/** Markdown links are URL-encoded; wiki links are not. */
function linkpathOf(syntax: Pick<EmbedSyntax, 'kind' | 'path'>): string | undefined {
	if (syntax.kind === 'wiki') return syntax.path;
	try {
		return decodeURI(syntax.path);
	} catch {
		return undefined;
	}
}

interface Prepared {
	file: SourceFile;
	sourceSha256: string;
	/** An image's bytes while within maxJobMB; never kept for other files (3-1 step 3). */
	bytes: Uint8Array | undefined;
	/** An image over maxJobMB: shown, and left for the next run. */
	deferred: boolean;
	size: number;
	sentSha256: string;
	format: UploadFormat;
	contentType: string;
	converter: string;
	reencoded: boolean;
	preparedKey: string;
	occurrences: { embed: FoundEmbed; source: ReferenceSource }[];
}


const isNoteFile = (path: string) => ['md', 'canvas'].includes(extensionOf(path));

/** The path a link points to, before its syntax is checked: what decides whether it is a note link (5-4). */
function roughLinkPath(original: string): string | undefined {
	let path: string;
	if (original.startsWith('[[')) path = original.slice(2, -2).split('|')[0]!.replace(/\\$/, '');
	else {
		const dest = /\]\((<[^>\n]*>|\S*)/.exec(original.slice(original.lastIndexOf('](')))?.[1] ?? '';
		try {
			path = decodeURI(dest.replace(/^<|>$/g, ''));
		} catch {
			return undefined;
		}
	}
	return path.split('#')[0]!;
}

/** Elements whose ranges meet another's (`[![a](a.png)](x.pdf)`): rewriting one would change the other (9-1). */
function overlapping(elements: readonly FoundEmbed[]): Set<FoundEmbed> {
	const out = new Set<FoundEmbed>();
	let holder: FoundEmbed | undefined;
	for (const e of [...elements].sort((a, b) => a.offset - b.offset)) {
		if (holder && e.offset < holder.offset + holder.original.length) {
			out.add(holder);
			out.add(e);
		}
		if (!holder || e.offset + e.original.length > holder.offset + holder.original.length) holder = e;
	}
	return out;
}

/** 10-1 step 4: reads, converts and keys every target, and groups them by sentSha256 (6-0). Writes nothing. */
export async function prepareJob(input: PrepareInput, deps: PrepareDeps): Promise<{ ok: true; plan: JobPlan } | { ok: false; reason: PrepareFailure; detail?: string }> {
	const target = jobTarget(input.connection);
	const templateError = checkTemplate(target.keyTemplate);
	if (templateError) return { ok: false, reason: 'template', detail: templateError.reason };
	if (target.classification === 'public' && (target.publicBaseUrl === undefined || validatePublicBaseUrl(target.publicBaseUrl))) {
		return { ok: false, reason: 'public-url' };
	}
	const upload = input.settings.upload;
	const privateFiles = new Set(input.settings.privateFiles);
	const date = deps.now();
	const skipped: SkippedEmbed[] = [];
	const byPath = new Map<string, Prepared | { skip: SkipReason; detail?: string }>();
	const order: Prepared[] = [];
	/** Bytes kept per sentSha256; undefined for bytes over the limit. */
	const held = new Map<string, Uint8Array | undefined>();
	let total = 0;
	let over = false;
	const skip = (embed: FoundEmbed, reason: SkipReason, detail?: string) =>
		skipped.push({ offset: embed.offset, original: embed.original, reason, ...(detail === undefined ? {} : { detail }) });

	const phase4 = deps.attachments === true;
	const links = phase4 ? (input.links ?? []) : [];
	const nested = phase4 ? overlapping([...input.embeds, ...links]) : new Set<FoundEmbed>();
	const all = [...input.embeds.map((e) => ({ kind: 'embed' as const, e })), ...links.map((e) => ({ kind: 'link' as const, e }))].sort((a, b) => a.e.offset - b.e.offset);

	for (const { kind, e: embed } of all) {
		if (kind === 'link') {
			// 5-4: links to notes, headings and notes not written yet are not attachments, and not listed at all.
			const rough = roughLinkPath(embed.original);
			const to = rough ? deps.resolveLink(rough) : undefined;
			// A path that cannot be decoded goes on to the syntax check, which lists it as unparsable.
			if (rough !== undefined && (rough === '' || (to ? isNoteFile(to.path) : extensionOf(rough) === '' || isNoteFile(rough)))) continue;
		}
		if (embed.inComment) {
			skip(embed, 'comment');
			continue;
		}
		const parsed = kind === 'embed' ? parseEmbedSyntax(embed.original, embed.inTable) : parseLinkSyntax(embed.original, embed.inTable);
		if (!parsed.ok) {
			skip(embed, parsed.reason);
			continue;
		}
		const source: ReferenceSource = kind === 'embed' ? { kind, syntax: parsed.value as EmbedSyntax } : { kind, syntax: parsed.value as LinkSyntax };
		if (embed.inNestedTable && embed.original.includes('|')) {
			skip(embed, 'nested-table');
			continue;
		}
		if (nested.has(embed)) {
			skip(embed, 'overlapping');
			continue;
		}
		const linkpath = linkpathOf(source.syntax);
		const file = linkpath === undefined ? undefined : deps.resolveLink(linkpath);
		if (!file) {
			skip(embed, linkpath === undefined ? 'unparsable' : 'not-found');
			continue;
		}
		if (phase4 && isNoteFile(file.path)) continue;
		if (phase4 && file.path.startsWith(`${ARCHIVE_FOLDER}/`)) {
			skip(embed, 'in-archive');
			continue;
		}
		const known = byPath.get(file.path);
		if (known) {
			if ('skip' in known) skip(embed, known.skip, known.detail);
			else known.occurrences.push({ embed, source });
			continue;
		}
		const r = await prepareFile(file, target, input, privateFiles, date, deps);
		if ('skip' in r) {
			byPath.set(file.path, r);
			skip(embed, r.skip, r.detail);
			continue;
		}
		if (!r.bytes) {
			// Design 3-1 step 4: other files hold no bytes, so maxJobMB does not count them and they are never deferred.
			const p: Prepared = { ...r, bytes: undefined, deferred: false, occurrences: [{ embed, source }] };
			byPath.set(file.path, p);
			order.push(p);
			continue;
		}
		// maxJobMB counts each image's sentSha256 once, in the order the files appear. Equal bytes share the first
		// copy; once the limit is exceeded, new bytes are dropped right away and the rest waits for the next run.
		let bytes: Uint8Array | undefined = held.get(r.sentSha256);
		if (!bytes && !held.has(r.sentSha256) && !over && total + r.bytes.length <= upload.maxJobMB * MB) {
			total += r.bytes.length;
			bytes = r.bytes;
		} else if (!bytes) over = true;
		held.set(r.sentSha256, bytes);
		const p: Prepared = { ...r, bytes, deferred: !bytes, occurrences: [{ embed, source }] };
		byPath.set(file.path, p);
		order.push(p);
	}
	if (phase4) for (const r of referenceDefinitions(input.snapshot, input.references ?? [], deps)) skipped.push(r);

	// 6-0 and design 3-8: one group per (sentSha256, contentType), in the order the files first appear in the note.
	const rt = rewriteTarget(target);
	const groups: (PlannedGroup & { deferred: boolean })[] = [];
	for (const p of order) {
		let g = groups.find((x) => x.sentSha256 === p.sentSha256 && x.contentType === p.contentType);
		if (!g) {
			const candidate = latestHistory(input.settings, target.target, p.sentSha256);
			g = {
				groupId: deps.newId(),
				key: candidate ?? p.preparedKey,
				preparedKey: p.preparedKey,
				phase: candidate ? 'candidate' : 'prepared',
				sentSha256: p.sentSha256,
				format: p.format,
				contentType: p.contentType,
				converter: p.converter,
				bytes: p.bytes,
				deferred: p.deferred,
				size: p.size,
				reencoded: p.reencoded,
				files: [],
			};
			groups.push(g);
		}
		const occurrences: PlannedOccurrence[] = [];
		const fileName = fileNameOf(p.file.path);
		let bad: SkipReason | undefined;
		for (const { embed, source } of p.occurrences) {
			const built = buildReference({ source, format: p.format, target: rt, key: g.key, fileName, fileBase: p.file.basename, inTable: embed.inTable });
			if (!built.ok) {
				bad ??= built.reason;
				continue;
			}
			occurrences.push({ offset: embed.offset, original: embed.original, inTable: embed.inTable, source, parts: built.parts, markdown: built.markdown });
		}
		// A file is rewritten everywhere or nowhere.
		if (bad) {
			for (const o of p.occurrences) skip(o.embed, bad);
			continue;
		}
		g.files.push({ itemId: deps.newId(), sourcePath: p.file.path, basename: p.file.basename, fileName, sourceSha256: p.sourceSha256, sourceSize: p.file.size, occurrences });
	}

	const sending: PlannedGroup[] = [];
	const deferred: DeferredGroup[] = [];
	for (const { deferred: later, bytes, ...g } of groups.filter((x) => x.files.length > 0)) {
		if (!later) sending.push({ ...g, bytes });
		else deferred.push(g);
	}
	skipped.sort((a, b) => a.offset - b.offset);
	return { ok: true, plan: { jobId: deps.newId(), notePath: input.notePath, snapshot: input.snapshot, target, groups: sending, deferred, skipped } };
}

async function prepareFile(
	file: SourceFile,
	target: JobTarget,
	input: PrepareInput,
	privateFiles: ReadonlySet<string>,
	date: Date,
	deps: Pick<PrepareDeps, 'encoder' | 'attachments'>,
): Promise<Omit<Prepared, 'occurrences' | 'deferred'> | { skip: SkipReason; detail?: string }> {
	const upload = input.settings.upload;
	const other = deps.attachments === true;
	// The size is known without reading: a large file is not read whole. Each format's own limit follows (3-1 step 1).
	if (file.size > (other ? Math.max(upload.maxFileMB, upload.maxOtherFileMB) : upload.maxFileMB) * MB) return { skip: 'too-large' };
	let source: Uint8Array;
	try {
		source = await file.read();
	} catch {
		return { skip: 'read-failed' };
	}
	// 3-1 step 2: image bytes take Phase 3's path whatever the extension; classifyFile is never asked about them.
	// So do bytes that only start like an image: Phase 3 rejects them rather than send them unstripped.
	if (other && detectImage(source).kind !== 'image' && !startsLikeImage(source)) return prepareOther(file, source, target, input, privateFiles, date);
	const policy = { classification: target.classification, stripPrivate: upload.stripPrivate, webp: { ...upload.webp }, maxFileMB: upload.maxFileMB };
	const prepared = await prepareBytes(source, policy, deps.encoder);
	if (!prepared.ok) return { skip: prepared.reason, ...(prepared.detail === undefined ? {} : { detail: prepared.detail }) };
	const sourceSha256 = sha256Hex(source);
	// Shown before confirming; the checkpoint before every request decides (I2).
	if (target.classification === 'public' && (privateFiles.has(sourceSha256) || privateFiles.has(prepared.sentSha256))) return { skip: 'private-recorded' };
	const key = buildKey(target.keyTemplate, { date, sourcePath: file.path, notePath: input.notePath, format: prepared.format, sentSha256: prepared.sentSha256 });
	if (!key.ok) return { skip: 'key-error', detail: key.reason };
	return {
		file,
		sourceSha256,
		bytes: prepared.bytes,
		size: prepared.bytes.length,
		sentSha256: prepared.sentSha256,
		format: prepared.format,
		contentType: imageContentType(prepared.format),
		converter: prepared.converter,
		reencoded: prepared.reencoded,
		preparedKey: key.key,
	};
}

/** The signature of PNG, JPEG, GIF or WebP, whether or not the rest can be read. */
function startsLikeImage(b: Uint8Array): boolean {
	const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
	return (
		(b[0] === 0x89 && ascii(1, 3) === 'PNG') ||
		(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
		ascii(0, 4) === 'GIF8' ||
		(ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP')
	);
}

/** Design 3-1 step 3: a file sent as it is, classified by its bytes. Its bytes are dropped once hashed. */
function prepareOther(
	file: SourceFile,
	source: Uint8Array,
	target: JobTarget,
	input: PrepareInput,
	privateFiles: ReadonlySet<string>,
	date: Date,
): Omit<Prepared, 'occurrences' | 'deferred'> | { skip: SkipReason; detail?: string } {
	// What was read decides, not the size the vault reported.
	if (source.length > input.settings.upload.maxOtherFileMB * MB) return { skip: 'too-large' };
	const sourceSha256 = sha256Hex(source);
	const verdict = classifyFile(source, extensionOf(file.path));
	if (target.classification === 'public' && verdict.publicUse === 'reject') return { skip: verdict.kind === 'ambiguous' ? 'ambiguous-format' : 'active-content' };
	if (target.classification === 'public' && privateFiles.has(sourceSha256)) return { skip: 'private-recorded' };
	const key = buildKey(target.keyTemplate, { date, sourcePath: file.path, notePath: input.notePath, format: verdict.format, sentSha256: sourceSha256 });
	if (!key.ok) return { skip: 'key-error', detail: key.reason };
	return {
		file,
		sourceSha256,
		bytes: undefined,
		size: source.length,
		sentSha256: sourceSha256,
		format: verdict.format,
		contentType: verdict.contentType,
		converter: ORIGINAL_CONVERTER,
		reencoded: false,
		preparedKey: key.key,
	};
}

const fileNameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Design 5-3 (D18): definitions `[id]: p` of an attachment are listed, never rewritten; usages `[t][id]` are not listed. */
function referenceDefinitions(snapshot: string, offsets: readonly number[], deps: Pick<PrepareDeps, 'resolveLink'>): SkippedEmbed[] {
	const out: SkippedEmbed[] = [];
	for (const offset of offsets) {
		const end = snapshot.indexOf('\n', offset);
		const line = snapshot.slice(offset, end < 0 ? undefined : end).replace(/\r$/, '');
		const m = /^\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/.exec(line);
		if (!m) continue;
		let path: string;
		try {
			path = decodeURI(m[1]!.replace(/^<|>$/g, '')).split('#')[0]!;
		} catch {
			continue;
		}
		const file = path === '' || /^[a-z][a-z0-9+.-]*:/i.test(path) ? undefined : deps.resolveLink(path);
		if (file && !isNoteFile(file.path)) out.push({ offset, original: line, reason: 'reference-style' });
	}
	return out;
}

function latestHistory(settings: DeepReadonly<PluginSettings>, target: TargetKey, sentSha256: string): string | undefined {
	let best: { key: string; at: string } | undefined;
	for (const h of settings.history) {
		if (h.target !== target || h.sentSha256 !== sentSha256) continue;
		if (!best || h.at > best.at) best = { key: h.key, at: h.at };
	}
	return best?.key;
}

// --- sending and applying ------------------------------------------------------

/** Recorded when the confirmation screen opens (10-1 step 5); every checkpoint compares against it. */
export interface Confirmed {
	/** stableStringify of the connection as shown. */
	connection: string;
	/** This device's authentication generation of the connection, if a profile is set. */
	authGeneration: number | undefined;
	apply: 'replace' | 'copy';
	/**
	 * Design 4-1: the items the user confirmed on this screen, each for the bytes shown (itemId → sentSha256). Kept
	 * in memory only: neither the records nor the settings hold it, and a later run asks again.
	 */
	confirmations: ReadonlyMap<string, string>;
}

export function confirmedValues(
	connection: DeepReadonly<StorageConnection>,
	authGeneration: number | undefined,
	apply: 'replace' | 'copy',
	confirmations: ReadonlyMap<string, string> = new Map(),
): Confirmed {
	return { connection: stableStringify(connection), authGeneration, apply, confirmations };
}

/** Design 4-1: what the user chose on the confirmation screen. */
export interface ConfirmChoice {
	apply: 'replace' | 'copy';
	/** Items whose format needs confirming in public storage and that the user confirmed. */
	confirmed: readonly string[];
}

/** Design 4-1: a public item of a format a person must confirm before it is put there (I15). */
export function needsConfirmation(item: { classification: 'public' | 'private'; format: UploadFormat }): boolean {
	return item.classification === 'public' && publicUseOf(item.format) === 'confirm';
}

const isConfirmedBy = (confirmations: ReadonlyMap<string, string>) => (item: DeepReadonly<PendingItem>) =>
	!needsConfirmation(item) || confirmations.get(item.id) === item.sentSha256;

export interface RunDeps {
	settings: Pick<SettingsStore, 'checkpoint' | 'mutate' | 'subscribe' | 'current' | 'readOnly'>;
	pending: PendingStore;
	/**
	 * A client with credentials that passed the authentication gate, resolved before each group (10-3: not
	 * inside the checkpoint). Rejects when the gate fails; the remaining groups are then not started.
	 */
	client(signal: AbortSignal): Promise<UploaderDeps['client']>;
	timeoutMs: number;
	/** Stop button and plugin unload. */
	signal: AbortSignal;
	authGeneration(connectionId: string): number | undefined;
	/** 10-2: the vault reported a modify, delete or rename of this path since preparing. */
	sourceChanged(path: string): boolean;
	readSource(path: string): Promise<Uint8Array | undefined>;
	/**
	 * Design 3-3: SHA-256 of a source computed from a stream, never holding the whole file; undefined if it cannot
	 * be read. Used for files other than images, which may be large.
	 */
	hashSource(path: string): Promise<string | undefined>;
	/** Size of a source as the vault reports it, read before reading the file whole; undefined if it is gone. */
	sourceSize(path: string): number | undefined;
	note: NoteAccess;
	copy(text: string): Promise<boolean>;
	sleep: UploaderDeps['sleep'];
	timers?: UploaderDeps['timers'];
	random(): number;
	now(): Date;
	newId(): string;
}

export type FileOutcome = ItemResult['outcome'] | 'not-started';

export interface FileResult {
	itemId: string;
	sourcePath: string;
	outcome: FileOutcome;
	reason?: string;
	key?: string;
	/** The note now links to the object (or the Markdown was copied). */
	linked: boolean;
}

/** Why the note was not replaced, so the Markdown was copied instead. */
export type NoteFallback = Extract<ApplyResult, { reason: 'closed' | 'deleted' | 'moved' | 'changed' }>;

export type LinkResult = { kind: 'none' } | { kind: 'applied'; apply: ApplyResult } | { kind: 'copied'; ok: boolean; fallback?: NoteFallback };

export interface JobResult {
	files: FileResult[];
	link: LinkResult;
	/** Why the job was aborted, if it was: files stopped as `aborted` were stopped by this. */
	aborted?: 'stop' | 'connection-changed' | 'auth-changed';
}

/** Job-level conditions inside every checkpoint (10-3 items 2 and 3). The store generation is not compared: the job's own saves change it. */
function jobCheck(deps: Pick<RunDeps, 'settings' | 'authGeneration'>, connectionId: string, confirmed: Pick<Confirmed, 'connection' | 'authGeneration'>) {
	return (settings: DeepReadonly<PluginSettings>): string | undefined => {
		if (deps.settings.readOnly) return 'read-only';
		const c = settings.connections.find((x) => x.id === connectionId);
		if (!c || stableStringify(c) !== confirmed.connection) return 'connection-changed';
		if (deps.authGeneration(c.id) !== confirmed.authGeneration) return 'auth-changed';
		return undefined;
	};
}

function newItems(plan: JobPlan, group: PlannedGroup, apply: 'replace' | 'copy'): NewPendingItem[] {
	return group.files.map((f) => ({
		id: f.itemId,
		jobId: plan.jobId,
		groupId: group.groupId,
		connectionId: plan.target.connectionId,
		target: plan.target.target,
		classification: plan.target.classification,
		notePath: plan.notePath,
		sourcePath: f.sourcePath,
		sourceSha256: f.sourceSha256,
		sentSha256: group.sentSha256,
		size: group.size,
		format: group.format,
		contentType: group.contentType,
		converter: group.converter,
		key: group.key,
		preparedKey: group.preparedKey,
		phase: group.phase,
		occurrences: f.occurrences.map((o) => ({
			original: o.original,
			kind: o.source.kind,
			alt: o.parts.alt,
			...(o.parts.size === undefined ? {} : { size: o.parts.size }),
			inTable: o.inTable,
		})),
		apply,
	}));
}

/** 10-1 steps 6 to 8 after the user confirmed `plan`. The caller holds the lock. */
export async function runJob(plan: JobPlan, confirmed: Confirmed, deps: RunDeps): Promise<JobResult> {
	const watch = watchAbort(deps.settings, deps.signal, plan.target.connectionId, confirmed.connection);
	try {
		const files = await sendAll(plan, confirmed, deps, watch.signal);
		const link = await linkDelivered(plan, confirmed, deps, files);
		const cause = watch.cause();
		return { files, link, ...(cause ? { aborted: cause } : {}) };
	} finally {
		watch.dispose();
	}
}

export type AbortCause = NonNullable<JobResult['aborted']>;

/** 10-4: the stop signal, or a change of the connection or of its authentication, stops the requests in flight. */
function watchAbort(settings: Pick<SettingsStore, 'subscribe' | 'current'>, stopSignal: AbortSignal, connectionId: string, connection: string) {
	const controller = new AbortController();
	let cause: AbortCause | undefined;
	const abort = (why: AbortCause) => {
		if (controller.signal.aborted) return;
		cause = why;
		controller.abort();
	};
	const stop = () => abort('stop');
	if (stopSignal.aborted) stop();
	stopSignal.addEventListener('abort', stop);
	const unsubscribe = settings.subscribe((change: StoreChange) => {
		const c = settings.current.connections.find((x) => x.id === connectionId);
		if (!c || stableStringify(c) !== connection) abort('connection-changed');
		else if (change.authChanged.includes(connectionId)) abort('auth-changed');
	});
	return {
		signal: controller.signal,
		cause: () => cause,
		dispose: () => {
			unsubscribe();
			stopSignal.removeEventListener('abort', stop);
		},
	};
}

type SourceDeps = Pick<RunDeps, 'settings' | 'sourceChanged' | 'readSource' | 'hashSource' | 'sourceSize'>;

/** 10-2: the source still has the hash it had when prepared. Other files are hashed from a stream (3-3). */
async function sourceUnchanged(deps: SourceDeps, item: Pick<PendingItem, 'sourcePath' | 'sourceSha256' | 'format'>): Promise<boolean> {
	const path = item.sourcePath;
	if (deps.sourceChanged(path)) return false;
	let sha: string | undefined;
	if (isImageFormat(item.format)) {
		const bytes = await deps.readSource(path);
		sha = bytes && sha256Hex(bytes);
	} else sha = await deps.hashSource(path);
	return sha !== undefined && !deps.sourceChanged(path) && sha === item.sourceSha256;
}

/**
 * Design 3-7: bytes made again are sent only as the recorded format, served as recorded and, in public storage,
 * as a format that may be public there.
 */
export function rebuiltFormatMatches(bytes: Uint8Array, item: Pick<PendingItem, 'format' | 'contentType' | 'sourcePath' | 'classification'>): boolean {
	if (isImageFormat(item.format)) {
		const info = detectImage(bytes);
		return info.kind === 'image' && info.format === item.format;
	}
	const v = classifyFile(bytes, extensionOf(item.sourcePath));
	return v.format === item.format && v.contentType === item.contentType && (item.classification !== 'public' || v.publicUse !== 'reject');
}

/**
 * Design 3-3: the bytes of a group of other files. Every source must still hash as prepared (from a stream); then
 * only the first is read whole, and sent if it is the recorded bytes and format.
 */
async function rebuildOther(deps: SourceDeps, items: readonly DeepReadonly<PendingItem>[]): Promise<Uint8Array | RebuildRefusal | undefined> {
	for (const i of items) if (!(await sourceUnchanged(deps, i))) return undefined;
	const first = items[0];
	if (!first) return undefined;
	const limit = deps.settings.current.upload.maxOtherFileMB * MB;
	// Replaced since it was hashed: a large file is not read whole (3-1 step 1).
	const size = deps.sourceSize(first.sourcePath);
	if (size === undefined || deps.sourceChanged(first.sourcePath)) return undefined;
	if (size > limit) return 'too-large';
	const bytes = await deps.readSource(first.sourcePath);
	if (!bytes || deps.sourceChanged(first.sourcePath)) return undefined;
	if (bytes.length > limit) return 'too-large';
	if (sha256Hex(bytes) !== first.sentSha256) return undefined;
	return rebuiltFormatMatches(bytes, first) ? bytes : 'format-changed';
}

async function sendAll(plan: JobPlan, confirmed: Confirmed, deps: RunDeps, signal: AbortSignal): Promise<FileResult[]> {
	const results: FileResult[] = [];
	let notStarted: string | undefined;
	for (const group of plan.groups) {
		const pathOf = new Map(group.files.map((f) => [f.itemId, f.sourcePath]));
		const skip = (reason?: string) => {
			for (const f of group.files) results.push({ itemId: f.itemId, sourcePath: f.sourcePath, outcome: 'not-started', ...(reason ? { reason } : {}), linked: false });
		};
		if (signal.aborted || notStarted) {
			skip(notStarted);
			continue;
		}
		let client: UploaderDeps['client'];
		try {
			client = await deps.client(signal);
		} catch {
			notStarted = signal.aborted ? undefined : 'credentials';
			skip(notStarted);
			continue;
		}
		const uploader: UploaderDeps = {
			pending: deps.pending,
			settings: deps.settings,
			client,
			signal,
			timeoutMs: deps.timeoutMs,
			check: jobCheck(deps, plan.target.connectionId, confirmed),
			sourceUnchanged: (item: DeepReadonly<PendingItem>) => sourceUnchanged(deps, item),
			isConfirmed: isConfirmedBy(confirmed.confirmations),
			sourceChanged: (item) => deps.sourceChanged(item.sourcePath),
			// Within the job an image's prepared bytes are the recorded ones, as long as every source is unchanged.
			// Other files are read again right before the first Put (3-3).
			rebuild: async (items) => {
				const bytes = group.bytes;
				if (!bytes) return rebuildOther(deps, items);
				for (const i of items) if (!(await sourceUnchanged(deps, i))) return undefined;
				return bytes;
			},
			sleep: deps.sleep,
			timers: deps.timers,
			random: () => deps.random(),
			now: () => deps.now(),
			newId: () => deps.newId(),
		};
		for (const r of await sendGroup(newItems(plan, group, confirmed.apply), group.bytes, uploader)) {
			results.push({ itemId: r.id, sourcePath: pathOf.get(r.id) ?? '', outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ...(r.key ? { key: r.key } : {}), linked: false });
		}
	}
	return results;
}

/** A delivered file whose links are ready to be written. */
interface LinkEntry {
	r: FileResult;
	f: PlannedFile;
	g: PlannedGroup;
	mds: string[];
}

/** Rounds of "recheck, leave the blocked files out, try again" before the links are left for a later copy. */
const LINK_ATTEMPTS = 5;

/**
 * Why links may not be written at this moment: the settings could not be read as they are now (a checkpoint then
 * runs with the last ones it had, so I2 and I4 cannot be checked), the job's connection is no longer the
 * confirmed, active one (I4; the Markdown would name a storage the user did not confirm), a public file is now
 * recorded as private (I2), or the vault reported a change of a source (10-2). The authentication generation does
 * not matter for a link.
 */
function linkBlocks(plan: JobPlan, confirmed: Confirmed, deps: RunDeps, settings: DeepReadonly<PluginSettings>, entries: readonly LinkEntry[]) {
	const readOnly = deps.settings.readOnly !== undefined;
	const c = settings.connections.find((x) => x.id === plan.target.connectionId);
	const connection = !c || stableStringify(c) !== confirmed.connection || connectionState(settings, c) !== 'active';
	const recorded = new Set(settings.privateFiles);
	const privateRecorded = plan.target.classification === 'public' ? entries.filter((e) => recorded.has(e.f.sourceSha256) || recorded.has(e.g.sentSha256)) : [];
	const changed = entries.filter((e) => !privateRecorded.includes(e) && deps.sourceChanged(e.f.sourcePath));
	return { readOnly, connection, privateRecorded, changed, clear: !readOnly && !connection && privateRecorded.length === 0 && changed.length === 0 };
}

/**
 * 10-1 step 7: replace (or copy) the links of delivered files only. The write starts inside the last checkpoint,
 * after every await, and the note write asks once more at the moment it writes (I2, I4, 10-2).
 */
async function linkDelivered(plan: JobPlan, confirmed: Confirmed, deps: RunDeps, results: FileResult[]): Promise<LinkResult> {
	const rt = rewriteTarget(plan.target);
	const files = new Map(plan.groups.flatMap((g) => g.files.map((f) => [f.itemId, { f, g }] as const)));
	let ready = results.filter((r) => r.outcome === 'delivered' && r.key !== undefined);

	// 10-2: a source changed after preparing gets no link; its object may hold the old content.
	const changed: FileResult[] = [];
	for (const r of ready) {
		const e = files.get(r.itemId)!;
		if (!(await sourceUnchanged(deps, { sourcePath: e.f.sourcePath, sourceSha256: e.f.sourceSha256, format: e.g.format }))) changed.push(r);
	}
	await unlink(deps, changed, 'changed');
	ready = ready.filter((r) => !changed.includes(r));

	// I14 (f), design 3-5: a public link is written only to an object whose delivery form was checked (our Put, or a
	// Head that matched the Content-Type) and whose format may be public at all.
	if (plan.target.classification === 'public') {
		const unchecked = ready.filter((r) => {
			const item = deps.pending.items.find((i) => i.id === r.itemId);
			return !item || !item.deliveryChecked || publicUseOf(item.format) === 'reject';
		});
		await unlink(deps, unchecked, 'delivery-unchecked');
		ready = ready.filter((r) => !unchecked.includes(r));
	}

	let entries: LinkEntry[] = [];
	for (const r of ready) {
		const { f, g } = files.get(r.itemId)!;
		const key = r.key!;
		const built = f.occurrences.map((o) => buildReference({ source: o.source, format: g.format, target: rt, key, fileName: f.fileName, fileBase: f.basename, inTable: o.inTable }));
		// 9-3: each must read back as one embed or link with this key; otherwise it stays delivered (copy later).
		const mds = built.flatMap((b) => (b.ok ? [b.markdown] : []));
		if (mds.length !== built.length) {
			r.reason = 'markdown-check';
			continue;
		}
		entries.push({ r, f, g, mds });
	}

	const replacements = () => entries.flatMap((e) => e.f.occurrences.map((o, i) => ({ offset: o.offset, length: o.original.length, text: e.mds[i]! })));
	const lines = () => [...new Set(entries.flatMap((e) => e.mds))];
	const done = async () => {
		for (const e of entries) e.r.linked = true;
		await deps.pending.removeCompleted(entries.map((e) => e.r.itemId));
	};
	let mode = confirmed.apply;
	let fallback: NoteFallback | undefined;
	for (let attempt = 0; attempt < LINK_ATTEMPTS && entries.length > 0; attempt++) {
		type Step = { blocks: ReturnType<typeof linkBlocks> } | { copying: Promise<boolean> } | { applying: Promise<ApplyResult> };
		const step = await deps.settings
			.checkpoint((s): Step => {
				const blocks = linkBlocks(plan, confirmed, deps, s, entries);
				if (!blocks.clear) return { blocks };
				if (mode === 'copy') return { copying: deps.copy(lines().join('\n')) };
				const allowed = () => linkBlocks(plan, confirmed, deps, deps.settings.current, entries).clear;
				return { applying: applyToNote(deps.note, plan.snapshot, replacements(), allowed) };
			})
			.catch(() => undefined);
		// The settings could not be checked: nothing is written; the records stay delivered for a later copy.
		if (!step) break;
		if ('blocks' in step) {
			const { blocks } = step;
			if (blocks.readOnly) {
				// Nothing is written and no record changes; the records stay delivered for a later copy.
				for (const e of entries) e.r.reason = 'read-only';
				break;
			}
			if (blocks.connection) {
				// I4: delivered under the confirmed connection; the copy later uses the connection as it is then.
				for (const e of entries) e.r.reason = 'connection-changed';
				break;
			}
			await unlink(deps, blocks.privateRecorded.map((e) => e.r), 'private-recorded');
			await unlink(deps, blocks.changed.map((e) => e.r), 'changed');
			entries = entries.filter((e) => !blocks.privateRecorded.includes(e) && !blocks.changed.includes(e));
			continue;
		}
		if ('copying' in step) {
			const ok = await step.copying;
			if (ok) await done();
			return { kind: 'copied', ok, ...(fallback ? { fallback } : {}) };
		}
		const apply = await step.applying;
		if (apply.applied) {
			// 7-2: the record goes only once the replacement was read back; otherwise it stays for a copy.
			if (apply.verified) await done();
			return { kind: 'applied', apply };
		}
		if (apply.reason !== 'blocked') {
			fallback = { applied: false, reason: apply.reason };
			mode = 'copy';
		}
	}
	return { kind: 'none' };
}

/** Delivered, but no link may be made: the object exists, so the record stays as unresolved. */
async function unlink(deps: RunDeps, results: readonly FileResult[], reason: string): Promise<void> {
	if (results.length === 0) return;
	await deps.pending.update(
		results.map((r) => r.itemId),
		{ state: 'unresolved', reason },
	);
	for (const r of results) {
		r.outcome = 'unresolved';
		r.reason = reason;
	}
}

// --- the command (10-1) --------------------------------------------------------

export type CommandStop =
	| { stop: 'busy' }
	| { stop: 'excluded-folder' }
	| { stop: 'pending-not-ready' }
	| { stop: 'no-connection' }
	| { stop: 'connection-not-active' }
	| { stop: 'detection'; detection: Exclude<Detection, { ok: true }> }
	| { stop: 'prepare'; reason: PrepareFailure; detail?: string }
	| { stop: 'cancelled'; plan: JobPlan }
	| { stop: 'preview'; plan: JobPlan };

export interface CommandDeps {
	lock: JobLock;
	pending: Pick<PendingStore, 'status'>;
	settings: Pick<SettingsStore, 'current'>;
	notePath: string;
	/** Default connection or the picker; undefined when the user closed it. */
	pickConnection(): Promise<DeepReadonly<StorageConnection> | undefined>;
	/** 8-1 and 8-3: snapshot of the note (saved first if needed) compared with the cache. */
	detect(): Promise<Detection>;
	prepare: PrepareDeps;
	authGeneration(connectionId: string): number | undefined;
	/** 11-2; undefined when cancelled. Not called in preview mode beyond showing the plan. */
	confirm(plan: JobPlan, preview: boolean): Promise<ConfirmChoice | undefined>;
	run(plan: JobPlan, confirmed: Confirmed): Promise<JobResult>;
}

/** The whole command; `preview` stops after the confirmation screen and never sends (I13). */
export async function uploadCommand(deps: CommandDeps, preview: boolean): Promise<CommandStop | { done: JobResult; plan: JobPlan }> {
	const release = deps.lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		if (inExcludedFolder(deps.notePath, deps.settings.current.upload.excludeFolders)) return { stop: 'excluded-folder' };
		if (!preview && deps.pending.status !== 'ready') return { stop: 'pending-not-ready' };
		const picked = await deps.pickConnection();
		if (!picked) return { stop: 'no-connection' };
		// I4: the latest settings, not the picker's copy.
		const connection = deps.settings.current.connections.find((c) => c.id === picked.id);
		if (!connection || connectionState(deps.settings.current, connection) !== 'active') return { stop: 'connection-not-active' };
		const detection = await deps.detect();
		if (!detection.ok) return { stop: 'detection', detection };
		const prepared = await prepareJob(
			{ notePath: deps.notePath, snapshot: detection.snapshot, embeds: detection.embeds, links: detection.links, references: detection.references, connection, settings: deps.settings.current },
			deps.prepare,
		);
		if (!prepared.ok) return { stop: 'prepare', reason: prepared.reason, ...(prepared.detail ? { detail: prepared.detail } : {}) };
		const plan = prepared.plan;
		// Recorded as the screen opens: the connection the plan was made with. A change since then stops the first checkpoint.
		const authGeneration = deps.authGeneration(connection.id);
		const choice = await deps.confirm(plan, preview);
		if (preview) return { stop: 'preview', plan };
		if (!choice) return { stop: 'cancelled', plan };
		// Each confirmation holds the bytes the screen showed for that item.
		const shown = new Map(plan.groups.flatMap((g) => g.files.map((f) => [f.itemId, g.sentSha256] as const)));
		const confirmations = new Map(choice.confirmed.flatMap((id) => (shown.has(id) ? [[id, shown.get(id)!] as const] : [])));
		return { done: await deps.run(plan, confirmedValues(connection, authGeneration, choice.apply, confirmations)), plan };
	} finally {
		release();
	}
}

// --- resuming (7-4) --------------------------------------------------------------

/**
 * Groups of stored records that a resume may send for: by groupId, in record order. Delivered items are never
 * resumed (their object and history exist; only copying the Markdown or removing them is left), so a group
 * with any delivered item is left out as a whole.
 */
export function resumableGroups(items: DeepReadonly<PendingItem[]>): string[][] {
	const groups = new Map<string, string[]>();
	const delivered = new Set(items.filter((i) => i.state === 'delivered').map((i) => i.groupId));
	for (const i of items) {
		if (delivered.has(i.groupId)) continue;
		groups.set(i.groupId, [...(groups.get(i.groupId) ?? []), i.id]);
	}
	return [...groups.values()];
}

/** 6-5 step 0: the record's storage is still the connection's storage, and the connection is in use. */
export function sameStorage(settings: DeepReadonly<PluginSettings>, item: DeepReadonly<PendingItem>): DeepReadonly<StorageConnection> | undefined {
	const c = settings.connections.find((x) => x.id === item.connectionId);
	return c && connectionState(settings, c) === 'active' && connectionTarget(c) === item.target && c.classification === item.classification ? c : undefined;
}

function recordTarget(c: DeepReadonly<StorageConnection>): Target | undefined {
	if (c.classification === 'private') return { classification: 'private', alias: c.alias };
	return c.publicBaseUrl !== undefined && !validatePublicBaseUrl(c.publicBaseUrl) ? { classification: 'public', publicBaseUrl: c.publicBaseUrl } : undefined;
}

/** The Markdown of a record's occurrences (6-5 step 4), with the connection as it is now; undefined if it cannot be made and checked. */
export function recordMarkdown(item: DeepReadonly<PendingItem>, connection: DeepReadonly<StorageConnection>): string[] | undefined {
	const target = recordTarget(connection);
	if (!target) return undefined;
	const key = item.altKey ?? item.key;
	// Design 6-4: the shape follows from the record as when it was prepared; the stored text is not escaped again.
	const parts = item.occurrences.map((o) => ({ shape: outputShape(o.kind, item.format, item.classification), alt: o.alt, ...(o.size === undefined ? {} : { size: o.size }), inTable: o.inTable }));
	if (!parts.every((x) => verifyMarkdown(markdownFor(x, target, key), target, key, x))) return undefined;
	return [...new Set(parts.map((x) => markdownFor(x, target, key)))];
}

export interface ResumeTarget {
	connection: DeepReadonly<StorageConnection>;
	/** Send groups (item ids) of this connection. */
	groups: string[][];
}

/** The resumable groups by connection, and the groups whose recorded storage no longer matches (not resumed, 6-5 step 0). */
export function resumeTargets(items: DeepReadonly<PendingItem[]>, settings: DeepReadonly<PluginSettings>): { ready: ResumeTarget[]; mismatched: string[][] } {
	const byId = new Map(items.map((i) => [i.id, i]));
	const ready = new Map<string, ResumeTarget>();
	const mismatched: string[][] = [];
	for (const ids of resumableGroups(items)) {
		const group = ids.map((id) => byId.get(id)!);
		const c = sameStorage(settings, group[0]!);
		if (!c || !group.every((i) => sameStorage(settings, i) === c)) {
			mismatched.push(ids);
			continue;
		}
		const t = ready.get(c.id) ?? { connection: c, groups: [] };
		t.groups.push(ids);
		ready.set(c.id, t);
	}
	return { ready: [...ready.values()], mismatched };
}

export interface ResumeDeps
	extends Pick<RunDeps, 'settings' | 'pending' | 'client' | 'timeoutMs' | 'signal' | 'authGeneration' | 'sourceChanged' | 'readSource' | 'hashSource' | 'sourceSize' | 'sleep' | 'timers' | 'random' | 'now' | 'newId'> {
	encoder: Encoder;
}

export interface ResumeResult {
	connectionId: string;
	results: ItemResult[];
	aborted?: AbortCause;
}

/**
 * 7-4: resumes the groups of one connection after the user confirmed them. The checks are those of a job: the
 * connection and authentication as confirmed, inside every checkpoint. Bytes are rebuilt from the source files
 * and must hash to the recorded sentSha256 (6-5 step 2); otherwise nothing is re-sent.
 */
export async function resumeJob(target: ResumeTarget, confirmed: Pick<Confirmed, 'connection' | 'authGeneration' | 'confirmations'>, deps: ResumeDeps): Promise<ResumeResult> {
	const id = target.connection.id;
	const watch = watchAbort(deps.settings, deps.signal, id, confirmed.connection);
	const sourceBytes = async (path: string, sha: string) => {
		if (deps.sourceChanged(path)) return undefined;
		const bytes = await deps.readSource(path);
		return bytes !== undefined && !deps.sourceChanged(path) && sha256Hex(bytes) === sha ? bytes : undefined;
	};
	const results: ItemResult[] = [];
	let notStarted: string | undefined;
	try {
		for (const ids of target.groups) {
			const skip = (reason?: string) => results.push(...ids.map((i) => ({ id: i, outcome: 'stopped' as const, ...(reason ? { reason } : {}) })));
			if (watch.signal.aborted || notStarted) {
				skip(notStarted ?? 'aborted');
				continue;
			}
			let client: UploaderDeps['client'];
			try {
				client = await deps.client(watch.signal);
			} catch {
				notStarted = watch.signal.aborted ? 'aborted' : 'credentials';
				skip(notStarted);
				continue;
			}
			const uploader: UploaderDeps = {
				pending: deps.pending,
				settings: deps.settings,
				client,
				signal: watch.signal,
				timeoutMs: deps.timeoutMs,
				check: jobCheck(deps, id, confirmed),
				sourceUnchanged: (item) => sourceUnchanged(deps, item),
				isConfirmed: isConfirmedBy(confirmed.confirmations),
				sourceChanged: (item) => deps.sourceChanged(item.sourcePath),
				rebuild: async (items) => {
					if (!items.every((i) => isImageFormat(i.format))) return rebuildOther(deps, items);
					let out: Uint8Array | undefined;
					for (const item of items) {
						const source = await sourceBytes(item.sourcePath, item.sourceSha256);
						const bytes = source && (await rebuildBytes(source, item, deps.encoder));
						if (!bytes) return undefined;
						// Design 3-7: rebuildBytes checks the hash and the method, not what the bytes are.
						if (!rebuiltFormatMatches(bytes, item)) return 'format-changed';
						out ??= bytes;
					}
					return out;
				},
				sleep: deps.sleep,
				timers: deps.timers,
				random: () => deps.random(),
				now: () => deps.now(),
				newId: () => deps.newId(),
			};
			results.push(...(await resumeGroup(ids, uploader)));
		}
	} finally {
		watch.dispose();
	}
	const cause = watch.cause();
	return { connectionId: id, results, ...(cause ? { aborted: cause } : {}) };
}

export type ResumeStop = { stop: 'busy' } | { stop: 'pending-not-ready' } | { stop: 'nothing'; mismatched: number } | { stop: 'cancelled' };

export interface ResumeCommandDeps {
	lock: JobLock;
	pending: Pick<PendingStore, 'status' | 'items'>;
	settings: Pick<SettingsStore, 'current'>;
	authGeneration(connectionId: string): number | undefined;
	/**
	 * The confirmation screen (I13: a previous session's confirmation is not enough). Undefined cancels; otherwise
	 * the items the user confirmed for public storage (4-3: asked again, never taken from an earlier run).
	 */
	confirm(targets: readonly ResumeTarget[], mismatched: number): Promise<readonly string[] | undefined>;
	run(target: ResumeTarget, confirmed: Pick<Confirmed, 'connection' | 'authGeneration' | 'confirmations'>): Promise<ResumeResult>;
}

export async function resumeCommand(deps: ResumeCommandDeps): Promise<ResumeStop | { done: ResumeResult[]; mismatched: number }> {
	const release = deps.lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		if (deps.pending.status !== 'ready') return { stop: 'pending-not-ready' };
		const { ready, mismatched } = resumeTargets(deps.pending.items, deps.settings.current);
		if (ready.length === 0) return { stop: 'nothing', mismatched: mismatched.length };
		// Recorded as the screen opens, as for an upload.
		const shown = new Map(deps.pending.items.map((i) => [i.id, i.sentSha256]));
		const confirmed = new Map(ready.map((t) => [t.connection.id, { connection: stableStringify(t.connection), authGeneration: deps.authGeneration(t.connection.id) }]));
		const chosen = await deps.confirm(ready, mismatched.length);
		if (!chosen) return { stop: 'cancelled' };
		const confirmations = new Map(chosen.flatMap((id) => (shown.has(id) ? [[id, shown.get(id)!] as const] : [])));
		const done: ResumeResult[] = [];
		for (const t of ready) done.push(await deps.run(t, { ...confirmed.get(t.connection.id)!, confirmations }));
		return { done, mismatched: mismatched.length };
	} finally {
		release();
	}
}

export interface CopyDeps {
	lock: JobLock;
	pending: PendingStore;
	settings: Pick<SettingsStore, 'current' | 'checkpoint' | 'readOnly'>;
	copy(text: string): Promise<boolean>;
	/**
	 * Design 3-6 (D22): a client for the Head that checks the delivery form of a public record that was never
	 * checked (records from Phase 3). Without it such records are not copied.
	 */
	client?(connectionId: string, signal: AbortSignal): Promise<Pick<S3Client, 'send'>>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type CopySkipReason = 'target-mismatch' | 'markdown-check' | 'private-recorded' | 'delivery-unchecked' | 'public-format';

export type CopyResult = { stop: 'busy' | 'pending-not-ready' | 'nothing' } | { copied: number; ok: boolean; skipped: { id: string; reason: CopySkipReason }[] };

/**
 * D22: one Head, started inside a checkpoint (same storage as recorded, not read-only, I2), that the object at the
 * record's key holds the recorded bytes and is served as the record's Content-Type with no Content-Disposition.
 */
async function checkDelivery(deps: CopyDeps, item: DeepReadonly<PendingItem>): Promise<boolean> {
	if (!deps.client) return false;
	const signal = deps.signal ?? new AbortController().signal;
	let client: Pick<S3Client, 'send'>;
	try {
		client = await deps.client(item.connectionId, signal);
	} catch {
		return false;
	}
	const started = await deps.settings
		.checkpoint((s) => {
			if (deps.settings.readOnly !== undefined) return undefined;
			const c = sameStorage(s, item);
			const recorded = new Set(s.privateFiles);
			if (!c || recorded.has(item.sourceSha256) || recorded.has(item.sentSha256)) return undefined;
			return { response: client.send(headCommand(c.bucket, item.altKey ?? item.key), { abortSignal: signal, requestTimeout: deps.timeoutMs }) };
		})
		.catch(() => undefined);
	if (!started) return false;
	try {
		return compareHead(await started.response, item.sentSha256, { contentType: item.contentType }) === 'match';
	} catch {
		return false;
	}
}

/**
 * "Copy Markdown" for the delivered records of one note (7-4, 6-5 step 4), so the lines can be pasted where they
 * belong: links to the storage as the connection is now, with I2 checked again for public links. Records are
 * removed only after the copy succeeded.
 */
export async function copyDelivered(deps: CopyDeps, notePath: string): Promise<CopyResult> {
	const release = deps.lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		if (deps.pending.status !== 'ready') return { stop: 'pending-not-ready' };
		const delivered = deps.pending.items.filter((i) => i.state === 'delivered' && i.notePath === notePath);
		if (delivered.length === 0) return { stop: 'nothing' };
		// D22: public records whose delivery form was never checked get one Head first; the current source file is
		// never the evidence (D13).
		const verified = new Set<string>();
		for (const item of delivered) {
			if (item.classification !== 'public' || item.deliveryChecked || publicUseOf(item.format) === 'reject') continue;
			if (await checkDelivery(deps, item)) {
				verified.add(item.id);
				await deps.pending.update([item.id], { deliveryChecked: true });
			}
		}
		type Skipped = Extract<CopyResult, { copied: number }>['skipped'];
		/** The lines and the records they stand for, with the settings of one checkpoint. */
		const evaluate = (s: DeepReadonly<PluginSettings>, items: readonly DeepReadonly<PendingItem>[]) => {
			const recorded = new Set(s.privateFiles);
			const skipped: Skipped = [];
			const lines: string[] = [];
			const ready: DeepReadonly<PendingItem>[] = [];
			for (const item of items) {
				if (item.classification === 'public' && (recorded.has(item.sourceSha256) || recorded.has(item.sentSha256))) {
					skipped.push({ id: item.id, reason: 'private-recorded' });
					continue;
				}
				// I14 (f): public URLs only for formats that may be public, at objects whose delivery form is known.
				if (item.classification === 'public' && publicUseOf(item.format) === 'reject') {
					skipped.push({ id: item.id, reason: 'public-format' });
					continue;
				}
				if (item.classification === 'public' && !item.deliveryChecked && !verified.has(item.id)) {
					skipped.push({ id: item.id, reason: 'delivery-unchecked' });
					continue;
				}
				const c = sameStorage(s, item);
				const mds = c && recordMarkdown(item, c);
				if (!mds) {
					skipped.push({ id: item.id, reason: c ? 'markdown-check' : 'target-mismatch' });
					continue;
				}
				for (const md of mds) if (!lines.includes(md)) lines.push(md);
				ready.push(item);
			}
			return { skipped, lines, ready };
		};
		const privateRecorded: Skipped = [];
		let items = delivered;
		for (;;) {
			// The copy starts inside the checkpoint that found nothing more to hold back, after every await (I2).
			const step = await deps.settings
				.checkpoint((s) => {
					// Read-only (e.g. data.json unreadable): these are the last settings it had, not the current ones.
					if (deps.settings.readOnly !== undefined) return undefined;
					const ev = evaluate(s, items);
					const held = ev.skipped.filter((x) => x.reason === 'private-recorded');
					return { ev, held, copying: held.length === 0 && ev.ready.length > 0 ? deps.copy(ev.lines.join('\n')) : undefined };
				})
				.catch(() => undefined);
			// The settings could not be checked: nothing is copied and no record changes.
			if (!step) return { copied: 0, ok: false, skipped: privateRecorded };
			const { ev, held, copying } = step;
			if (held.length > 0) {
				const ids = held.map((x) => x.id);
				await deps.pending.update(ids, { state: 'unresolved', reason: 'private-recorded' });
				privateRecorded.push(...held);
				items = items.filter((i) => !ids.includes(i.id));
				continue;
			}
			const skipped = [...privateRecorded, ...ev.skipped];
			if (!copying) return { copied: 0, ok: true, skipped };
			const ok = await copying;
			if (ok) await deps.pending.removeCompleted(ev.ready.map((i) => i.id));
			return { copied: ok ? ev.ready.length : 0, ok, skipped };
		}
	} finally {
		release();
	}
}

/** Runs a record operation (discard, takeover, reset) under the job lock (7-6). */
export async function withLock<T>(lock: JobLock, fn: () => Promise<T>): Promise<T | 'busy'> {
	const release = lock.acquire();
	if (!release) return 'busy';
	try {
		return await fn();
	} finally {
		release();
	}
}
