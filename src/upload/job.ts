// The upload job (design 10): one note, one connection, at most one job at a time. Preparing reads and converts
// but writes nothing (the preview command stops there, I13); sending goes group by group through the uploader;
// the note changes only over the exact snapshot, otherwise the Markdown is copied (I7). Obsidian stays outside:
// everything it provides is passed in.
import { stableStringify } from '../settings/migrate';
import { connectionState, connectionTarget } from '../settings/registry';
import type { SettingsStore, StoreChange } from '../settings/store';
import type { PluginSettings, StorageConnection, UploadFormat } from '../settings/types';
import type { TargetKey } from '../storage/target';
import type { DeepReadonly } from '../util/deepReadonly';
import { type Encoder, type PrepareRejection, prepareBytes, rebuildBytes, sha256Hex } from './convert';
import { type ImageFormat, imageContentType } from './fileType';
import { type Detection, type EmbedSyntax, type FoundEmbed, parseEmbedSyntax, type SyntaxRejection } from './detect';
import { buildKey, checkTemplate } from './key';
import type { NewPendingItem, PendingItem, PendingStore } from './pending';
import { altFor, applyToNote, type ApplyResult, buildMarkdown, markdownFor, type NoteAccess, type Target, verifyMarkdown } from './rewrite';
import { type ItemResult, resumeGroup, sendGroup, type UploaderDeps } from './uploader';
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
	| 'key-error'
	| 'markdown-check';

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
	syntax: EmbedSyntax;
	/** With the group's key as prepared; rebuilt with the final key before applying. */
	markdown: string;
}

export interface PlannedFile {
	itemId: string;
	sourcePath: string;
	basename: string;
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
	bytes: Uint8Array;
	/** Bytes sent: bytes.length, kept for the screen where the bytes are not held. */
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
	connection: DeepReadonly<StorageConnection>;
	settings: DeepReadonly<PluginSettings>;
}

export interface PrepareDeps {
	/** metadataCache.getFirstLinkpathDest from the note; undefined unless it is a file in the vault. */
	resolveLink(linkpath: string): SourceFile | undefined;
	encoder: Encoder;
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
function linkpathOf(syntax: EmbedSyntax): string | undefined {
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
	/** Undefined once the file is over maxJobMB: only what the screen shows is kept. */
	bytes: Uint8Array | undefined;
	size: number;
	sentSha256: string;
	format: ImageFormat;
	converter: string;
	reencoded: boolean;
	preparedKey: string;
	occurrences: { embed: FoundEmbed; syntax: EmbedSyntax }[];
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

	for (const embed of input.embeds) {
		if (embed.inComment) {
			skip(embed, 'comment');
			continue;
		}
		const parsed = parseEmbedSyntax(embed.original, embed.inTable);
		if (!parsed.ok) {
			skip(embed, parsed.reason);
			continue;
		}
		if (embed.inNestedTable && embed.original.includes('|')) {
			skip(embed, 'nested-table');
			continue;
		}
		const linkpath = linkpathOf(parsed.value);
		const file = linkpath === undefined ? undefined : deps.resolveLink(linkpath);
		if (!file) {
			skip(embed, linkpath === undefined ? 'unparsable' : 'not-found');
			continue;
		}
		const known = byPath.get(file.path);
		if (known) {
			if ('skip' in known) skip(embed, known.skip, known.detail);
			else known.occurrences.push({ embed, syntax: parsed.value });
			continue;
		}
		const r = await prepareFile(file, target, input, privateFiles, date, deps.encoder);
		if ('skip' in r) {
			byPath.set(file.path, r);
			skip(embed, r.skip, r.detail);
			continue;
		}
		// maxJobMB counts each sentSha256 once, in the order the files appear. Equal bytes share the first copy;
		// once the limit is exceeded, new bytes are dropped right away and the rest waits for the next run.
		let bytes: Uint8Array | undefined = held.get(r.sentSha256);
		if (!bytes && !held.has(r.sentSha256) && !over && total + r.bytes.length <= upload.maxJobMB * MB) {
			total += r.bytes.length;
			bytes = r.bytes;
		} else if (!bytes) over = true;
		held.set(r.sentSha256, bytes);
		const p: Prepared = { ...r, bytes, size: r.bytes.length, occurrences: [{ embed, syntax: parsed.value }] };
		byPath.set(file.path, p);
		order.push(p);
	}

	// 6-0: one group per sentSha256, in the order the files first appear in the note.
	const rt = rewriteTarget(target);
	const groups: (DeferredGroup & { bytes: Uint8Array | undefined })[] = [];
	for (const p of order) {
		let g = groups.find((x) => x.sentSha256 === p.sentSha256);
		if (!g) {
			const candidate = latestHistory(input.settings, target.target, p.sentSha256);
			g = {
				groupId: deps.newId(),
				key: candidate ?? p.preparedKey,
				preparedKey: p.preparedKey,
				phase: candidate ? 'candidate' : 'prepared',
				sentSha256: p.sentSha256,
				format: p.format,
				contentType: imageContentType(p.format),
				converter: p.converter,
				bytes: p.bytes,
				size: p.size,
				reencoded: p.reencoded,
				files: [],
			};
			groups.push(g);
		}
		const occurrences: PlannedOccurrence[] = [];
		let bad = false;
		for (const { embed, syntax } of p.occurrences) {
			const markdown = buildMarkdown({ syntax, target: rt, key: g.key, fileBase: p.file.basename, inTable: embed.inTable });
			if (!verifyMarkdown(markdown, rt, g.key)) bad = true;
			occurrences.push({ offset: embed.offset, original: embed.original, inTable: embed.inTable, syntax, markdown });
		}
		if (bad) {
			for (const o of p.occurrences) skip(o.embed, 'markdown-check');
			continue;
		}
		g.files.push({ itemId: deps.newId(), sourcePath: p.file.path, basename: p.file.basename, sourceSha256: p.sourceSha256, sourceSize: p.file.size, occurrences });
	}

	const sending: PlannedGroup[] = [];
	const deferred: DeferredGroup[] = [];
	for (const { bytes, ...g } of groups.filter((x) => x.files.length > 0)) {
		if (bytes) sending.push({ ...g, bytes });
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
	encoder: Encoder,
): Promise<Omit<Prepared, 'occurrences' | 'bytes' | 'size'> & { bytes: Uint8Array } | { skip: SkipReason; detail?: string }> {
	const upload = input.settings.upload;
	// The size is known without reading: a large file is not read whole.
	if (file.size > upload.maxFileMB * MB) return { skip: 'too-large' };
	let source: Uint8Array;
	try {
		source = await file.read();
	} catch {
		return { skip: 'read-failed' };
	}
	const policy = { classification: target.classification, stripPrivate: upload.stripPrivate, webp: { ...upload.webp }, maxFileMB: upload.maxFileMB };
	const prepared = await prepareBytes(source, policy, encoder);
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
		sentSha256: prepared.sentSha256,
		format: prepared.format,
		converter: prepared.converter,
		reencoded: prepared.reencoded,
		preparedKey: key.key,
	};
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
}

export function confirmedValues(connection: DeepReadonly<StorageConnection>, authGeneration: number | undefined, apply: 'replace' | 'copy'): Confirmed {
	return { connection: stableStringify(connection), authGeneration, apply };
}

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
	note: NoteAccess;
	copy(text: string): Promise<boolean>;
	sleep: UploaderDeps['sleep'];
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
export type NoteFallback = Extract<ApplyResult, { reason: 'closed' | 'deleted' | 'changed' }>;

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
	const rt = rewriteTarget(plan.target);
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
			kind: 'embed' as const,
			alt: altFor({ syntax: o.syntax, target: rt, fileBase: f.basename }),
			...(o.syntax.size === undefined ? {} : { size: o.syntax.size }),
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

async function sendAll(plan: JobPlan, confirmed: Confirmed, deps: RunDeps, signal: AbortSignal): Promise<FileResult[]> {
	const sourceUnchanged = async (path: string, sha: string) => {
		if (deps.sourceChanged(path)) return false;
		const bytes = await deps.readSource(path);
		return bytes !== undefined && !deps.sourceChanged(path) && sha256Hex(bytes) === sha;
	};
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
			sourceUnchanged: (item: DeepReadonly<PendingItem>) => sourceUnchanged(item.sourcePath, item.sourceSha256),
			sourceChanged: (item) => deps.sourceChanged(item.sourcePath),
			// Within the job the prepared bytes are the recorded ones, as long as every source is unchanged.
			rebuild: async (items) => {
				for (const i of items) if (!(await sourceUnchanged(i.sourcePath, i.sourceSha256))) return undefined;
				return group.bytes;
			},
			sleep: deps.sleep,
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
		if (deps.sourceChanged(e.f.sourcePath)) changed.push(r);
		else {
			const bytes = await deps.readSource(e.f.sourcePath);
			if (bytes === undefined || sha256Hex(bytes) !== e.f.sourceSha256) changed.push(r);
		}
	}
	await unlink(deps, changed, 'changed');
	ready = ready.filter((r) => !changed.includes(r));

	let entries: LinkEntry[] = [];
	for (const r of ready) {
		const { f, g } = files.get(r.itemId)!;
		const key = r.key!;
		const mds = f.occurrences.map((o) => buildMarkdown({ syntax: o.syntax, target: rt, key, fileBase: f.basename, inTable: o.inTable }));
		// 9-3: each link must read back as one image with this key; otherwise it stays delivered (copy later).
		if (!mds.every((md) => verifyMarkdown(md, rt, key))) {
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
	confirm(plan: JobPlan, preview: boolean): Promise<'replace' | 'copy' | undefined>;
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
			{ notePath: deps.notePath, snapshot: detection.snapshot, embeds: detection.embeds, connection, settings: deps.settings.current },
			deps.prepare,
		);
		if (!prepared.ok) return { stop: 'prepare', reason: prepared.reason, ...(prepared.detail ? { detail: prepared.detail } : {}) };
		const plan = prepared.plan;
		// Recorded as the screen opens: the connection the plan was made with. A change since then stops the first checkpoint.
		const authGeneration = deps.authGeneration(connection.id);
		const apply = await deps.confirm(plan, preview);
		if (preview) return { stop: 'preview', plan };
		if (!apply) return { stop: 'cancelled', plan };
		return { done: await deps.run(plan, confirmedValues(connection, authGeneration, apply)), plan };
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
	const mds = [...new Set(item.occurrences.map((o) => markdownFor(o, target, key)))];
	return mds.every((md) => verifyMarkdown(md, target, key)) ? mds : undefined;
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

export interface ResumeDeps extends Pick<RunDeps, 'settings' | 'pending' | 'client' | 'timeoutMs' | 'signal' | 'authGeneration' | 'sourceChanged' | 'readSource' | 'sleep' | 'random' | 'now' | 'newId'> {
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
export async function resumeJob(target: ResumeTarget, confirmed: Pick<Confirmed, 'connection' | 'authGeneration'>, deps: ResumeDeps): Promise<ResumeResult> {
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
				sourceUnchanged: async (item) => (await sourceBytes(item.sourcePath, item.sourceSha256)) !== undefined,
				sourceChanged: (item) => deps.sourceChanged(item.sourcePath),
				rebuild: async (items) => {
					let out: Uint8Array | undefined;
					for (const item of items) {
						const source = await sourceBytes(item.sourcePath, item.sourceSha256);
						const bytes = source && (await rebuildBytes(source, item, deps.encoder));
						if (!bytes) return undefined;
						out ??= bytes;
					}
					return out;
				},
				sleep: deps.sleep,
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
	/** The confirmation screen (I13: a previous session's confirmation is not enough). */
	confirm(targets: readonly ResumeTarget[], mismatched: number): Promise<boolean>;
	run(target: ResumeTarget, confirmed: Pick<Confirmed, 'connection' | 'authGeneration'>): Promise<ResumeResult>;
}

export async function resumeCommand(deps: ResumeCommandDeps): Promise<ResumeStop | { done: ResumeResult[]; mismatched: number }> {
	const release = deps.lock.acquire();
	if (!release) return { stop: 'busy' };
	try {
		if (deps.pending.status !== 'ready') return { stop: 'pending-not-ready' };
		const { ready, mismatched } = resumeTargets(deps.pending.items, deps.settings.current);
		if (ready.length === 0) return { stop: 'nothing', mismatched: mismatched.length };
		// Recorded as the screen opens, as for an upload.
		const confirmed = new Map(ready.map((t) => [t.connection.id, { connection: stableStringify(t.connection), authGeneration: deps.authGeneration(t.connection.id) }]));
		if (!(await deps.confirm(ready, mismatched.length))) return { stop: 'cancelled' };
		const done: ResumeResult[] = [];
		for (const t of ready) done.push(await deps.run(t, confirmed.get(t.connection.id)!));
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
}

export type CopyResult =
	| { stop: 'busy' | 'pending-not-ready' | 'nothing' }
	| { copied: number; ok: boolean; skipped: { id: string; reason: 'target-mismatch' | 'markdown-check' | 'private-recorded' }[] };

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
