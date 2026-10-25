import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity } from '@smithy/types';
import { abortError, raceAbort } from '../diagnostics/types';
import { parseReference } from '../reference/reference';
import { profileOf, type DeviceState } from '../settings/device';
import { activeConnectionFor, connectionTarget, resolveAlias } from '../settings/registry';
import type { PluginSettings, StorageConnection } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import { PreviewError, type PreviewErrorCode } from './errors';
import { FAILURE_TTL_MS, toPreviewError, type SharedCredentials } from './credentials';
import { classifyContent, extensionOf } from '../upload/fileType';
import { detectImage } from './imageInfo';
import { Limiter } from './limiter';
import { PixelBudget } from './pdf';

export interface PreviewImage {
	url: string;
	width: number;
	height: number;
}

/** Design 7-2: shown in a `pre` with textContent. */
export interface PreviewText {
	kind: 'text';
	text: string;
	/** Only the first TEXT_PREVIEW_UNITS UTF-16 code units are shown. */
	truncated: boolean;
}

/** Design 7-2: an SVG shown through `img` from a blob URL, so it runs no script and loads nothing. */
export interface PreviewSvg {
	kind: 'svg';
	url: string;
}

/** Design 7-4: what Head tells about an object that is not fetched, or whose bytes are not what its key says. */
export interface PreviewInfo {
	kind: 'info';
	name: string;
	size: number | undefined;
	type: InfoType;
	/**
	 * Why something that could be shown is not: the bytes did not match the format chosen from the key (7-1
	 * step 2), or pdf.js asked for a password or could not read the PDF (7-2).
	 */
	reason?: 'mismatch' | 'password' | 'broken';
}

/** Design 7-2: drawn by pdf.js from a copy of these cached bytes. */
export interface PreviewPdf {
	kind: 'pdf';
	name: string;
	size: number;
	bytes: Uint8Array;
}

export type InfoType = 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'zip' | 'audio' | 'video' | 'other';

/** An image (as in Phase 2) or one of the other displays of design 7-2. */
export type PreviewContent = PreviewImage | PreviewText | PreviewSvg | PreviewInfo | PreviewPdf;

/** Design 7-2: the first part of a text that is shown, in UTF-16 code units. */
export const TEXT_PREVIEW_UNITS = 262_144;

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
const TEXT_EXTENSIONS = ['txt', 'text', 'log', 'csv', 'tsv', 'json'];
const INFO_TYPE: Record<string, InfoType> = {
	pdf: 'pdf',
	docx: 'docx',
	xlsx: 'xlsx',
	pptx: 'pptx',
	zip: 'zip',
	...Object.fromEntries(['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'flac'].map((e) => [e, 'audio' as const])),
	...Object.fromEntries(['mp4', 'm4v', 'mov', 'ogv', 'webm'].map((e) => [e, 'video' as const])),
};

/**
 * Design 7-1 step 1: how an object is shown, from its key alone, before anything is fetched. `head` asks Head
 * first (a key without an extension); `info` fetches nothing but Head.
 */
export type PreviewPolicy = 'image' | 'svg' | 'text' | 'pdf' | 'info' | 'head';

export function policyOf(key: string): PreviewPolicy {
	const ext = extensionOf(key);
	if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
	if (ext === 'svg') return 'svg';
	if (ext === 'pdf') return 'pdf';
	if (TEXT_EXTENSIONS.includes(ext)) return 'text';
	return ext === '' ? 'head' : 'info';
}

/** Design 7-1 step 1 for a key without an extension: the Content-Type chooses a policy only, never the format. */
export function policyOfContentType(contentType: string | undefined): Exclude<PreviewPolicy, 'head'> {
	const t = (contentType ?? '').toLowerCase();
	if (t === 'application/pdf') return 'pdf';
	if (t === 'image/svg+xml') return 'svg';
	if (t.startsWith('text/plain')) return 'text';
	if (t.startsWith('image/')) return 'image';
	return 'info';
}

/** Design 7-2: the text shown, cut without splitting a surrogate pair. */
export function textPreview(bytes: Uint8Array): PreviewText {
	const all = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
	if (all.length <= TEXT_PREVIEW_UNITS) return { kind: 'text', text: all, truncated: false };
	let end = TEXT_PREVIEW_UNITS;
	const last = all.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return { kind: 'text', text: all.slice(0, end), truncated: true };
}

export interface Lease {
	readonly result: Promise<PreviewContent>;
	readonly released: boolean;
	release(): void;
}

export interface PreviewServiceDeps {
	settings(): DeepReadonly<PluginSettings>;
	device(): DeepReadonly<DeviceState>;
	credentials: SharedCredentials;
	/** Clients must share the service's request handler and are never destroyed individually. */
	s3For(connection: StorageConnection, credentials: AwsCredentialIdentity): Pick<S3Client, 'send'>;
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
	now(): number;
	concurrency?: number;
}

/** Everything needed to fetch, resolved before any network access. */
interface Resolved {
	connection: StorageConnection;
	generation: number;
	profile: string;
	key: string;
}

/** An in-flight existence check. */
interface Check {
	connectionId: string;
	epoch: number;
	controller: AbortController;
}

type EntryState =
	| { kind: 'loading'; controller: AbortController }
	| { kind: 'ready'; image: PreviewContent; bytes: number }
	| { kind: 'failed'; error: PreviewError; until: number };

interface Entry {
	id: string;
	connectionId: string;
	epoch: number;
	state: EntryState;
	leases: Set<LeaseImpl>;
	lastUsed: number;
	settle: { resolve(image: PreviewContent): void; reject(error: PreviewError): void; promise: Promise<PreviewContent> };
}

class LeaseImpl implements Lease {
	released = false;
	readonly result: Promise<PreviewContent>;
	private readonly controller = new AbortController();

	constructor(
		source: Promise<PreviewContent>,
		private readonly onRelease: (lease: LeaseImpl) => void,
	) {
		// Each lease gets its own abortable view of the (possibly shared) result.
		this.result = raceAbort(source, this.controller.signal);
		// Released leases reject with AbortError; nobody needs to observe that.
		this.result.catch(() => undefined);
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		this.controller.abort();
		this.onRelease(this);
	}
}

function deferred(): Entry['settle'] {
	let resolve!: (image: PreviewContent) => void;
	let reject!: (error: PreviewError) => void;
	const promise = new Promise<PreviewContent>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	promise.catch(() => undefined);
	return { resolve, reject, promise };
}

export class PreviewService {
	private readonly entries = new Map<string, Entry>();
	private readonly epochs = new Map<string, number>();
	private readonly limiter: Limiter;
	private readonly checks = new Set<Check>();
	private destroyed = false;
	/** Design 7-3: the pixels of drawn PDF pages, shared by every PDF preview. */
	readonly pixels = new PixelBudget();

	constructor(private readonly deps: PreviewServiceDeps) {
		this.limiter = new Limiter(deps.concurrency ?? 3);
	}

	/** Checks performed before any network access. */
	resolve(src: string): Resolved | PreviewError {
		const parsed = parseReference(src);
		if (!parsed.ok) return new PreviewError('invalid-reference');
		const settings = this.deps.settings();
		const { alias, key } = parsed.value;
		const state = resolveAlias(settings, alias);
		if (state.kind === 'unbound') return new PreviewError('unknown-alias', { alias });
		if (state.kind === 'conflict') return new PreviewError('alias-conflict', { alias });
		if (state.classification !== 'private') return new PreviewError('public-connection', { alias });
		const connection = activeConnectionFor(settings, alias);
		if (!connection) return new PreviewError('connection-missing', { alias });
		if (connection.classification !== 'private') return new PreviewError('public-connection', { alias });
		const profile = profileOf(this.deps.device(), connection.id);
		if (!profile) return new PreviewError('profile-not-set', { alias });
		return { connection, generation: profile.generation, profile: profile.profile, key };
	}

	acquire(src: string): Lease {
		const resolved = this.destroyed ? new PreviewError('aborted') : this.resolve(src);
		if (resolved instanceof PreviewError) return new LeaseImpl(Promise.reject(resolved), () => undefined);
		const { connection, generation, key } = resolved;
		const id = `${connection.id}|${generation}|${connectionTarget(connection)}|${key}`;
		const now = this.deps.now();
		let entry = this.entries.get(id);
		if (entry?.state.kind === 'failed' && entry.state.until <= now) {
			this.entries.delete(id);
			entry = undefined;
		}
		if (!entry) entry = this.startEntry(id, resolved);
		const current = entry;
		current.lastUsed = now;
		const lease = new LeaseImpl(current.settle.promise, (l) => this.onRelease(current, l));
		current.leases.add(lease);
		return lease;
	}

	private startEntry(id: string, r: Resolved): Entry {
		const entry: Entry = {
			id,
			connectionId: r.connection.id,
			epoch: this.epochs.get(r.connection.id) ?? 0,
			state: { kind: 'loading', controller: new AbortController() },
			leases: new Set(),
			lastUsed: this.deps.now(),
			settle: deferred(),
		};
		this.entries.set(id, entry);
		void this.load(entry, r);
		return entry;
	}

	private isCurrent(entry: Entry): boolean {
		return !this.destroyed && this.entries.get(entry.id) === entry && (this.epochs.get(entry.connectionId) ?? 0) === entry.epoch;
	}

	private async load(entry: Entry, r: Resolved): Promise<void> {
		if (entry.state.kind !== 'loading') return;
		const controller = entry.state.controller;
		const signal = controller.signal;
		const settings = this.deps.settings();
		const MB = 1024 * 1024;
		let url: string | undefined;
		try {
			const releaseSlot = await this.limiter.acquire(signal);
			try {
				const credentials = await this.deps.credentials.get(r.connection.id, r.generation, r.profile, r.connection.region, signal);
				const s3 = this.deps.s3For(r.connection, credentials);
				const head = () => s3.send(new HeadObjectCommand({ Bucket: r.connection.bucket, Key: r.key }), { abortSignal: signal });
				const name = r.key.slice(r.key.lastIndexOf('/') + 1);
				const info = (size: number | undefined, mismatch = false): PreviewInfo => ({
					kind: 'info',
					name,
					size,
					type: INFO_TYPE[extensionOf(r.key)] ?? 'other',
					...(mismatch ? { reason: 'mismatch' as const } : {}),
				});
				let policy = policyOf(r.key);
				let headSize: number | undefined;
				if (policy === 'head') {
					const h = await head();
					headSize = h.ContentLength;
					policy = policyOfContentType(h.ContentType);
				}
				let shown: PreviewContent;
				let held = 0;
				if (policy === 'info') {
					// Design 7-1: neither downloaded nor opened; Head tells its size.
					shown = info(headSize ?? (await head()).ContentLength);
				} else {
					const maxMB = policy === 'text' ? settings.preview.maxTextMB : policy === 'pdf' ? settings.preview.maxPdfMB : settings.preview.maxFileMB;
					const maxBytes = maxMB * MB;
					const response = await s3.send(new GetObjectCommand({ Bucket: r.connection.bucket, Key: r.key }), { abortSignal: signal });
					if ((response.ContentLength ?? 0) > maxBytes) {
						// Nothing was read yet: free the connection instead of leaving the body dangling.
						discardBody(response.Body);
						controller.abort();
						throw new PreviewError('too-large');
					}
					const bytes = await readLimited(response.Body, maxBytes, signal);
					held = bytes.length;
					if (policy === 'image') {
						const img = detectImage(bytes);
						if (img.kind === 'svg') throw new PreviewError('unsupported-svg');
						if (img.kind !== 'image') throw new PreviewError('unsupported-format');
						if (img.width * img.height > settings.preview.maxMegapixels * 1_000_000) throw new PreviewError('too-many-pixels');
						url = this.deps.createObjectURL(new Blob([new Uint8Array(bytes)], { type: img.mime }));
						shown = { url, width: img.width, height: img.height };
					} else if (classifyContent(bytes) !== policy) {
						// 7-1 step 2: the bytes decide; the key or another tool's Content-Type never does.
						shown = info(bytes.length, true);
					} else if (policy === 'pdf') {
						// Kept as fetched; each display hands pdf.js its own copy (7-1 step 3).
						shown = { kind: 'pdf', name, size: bytes.length, bytes };
					} else if (policy === 'svg') {
						url = this.deps.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/svg+xml' }));
						shown = { kind: 'svg', url };
					} else {
						shown = textPreview(bytes);
					}
				}
				if (!this.isCurrent(entry)) {
					if (url) this.deps.revokeObjectURL(url);
					entry.settle.reject(new PreviewError('aborted'));
					return;
				}
				entry.state = { kind: 'ready', image: shown, bytes: held };
				entry.settle.resolve(shown);
				if (entry.leases.size === 0) this.evictUnused();
			} finally {
				releaseSlot();
			}
		} catch (error) {
			const e = toPreviewError(error);
			entry.settle.reject(e);
			if (!this.isCurrent(entry)) return;
			if (e.code === 'aborted') this.entries.delete(entry.id);
			else entry.state = { kind: 'failed', error: e, until: this.deps.now() + FAILURE_TTL_MS };
		}
	}

	private onRelease(entry: Entry, lease: LeaseImpl): void {
		entry.leases.delete(lease);
		if (entry.leases.size > 0) return;
		entry.lastUsed = this.deps.now();
		if (entry.state.kind === 'loading') {
			// Last user left: stop the shared download.
			entry.state.controller.abort();
			if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
		} else if (entry.state.kind === 'ready') {
			this.evictUnused();
		}
	}

	/** Keeps unused (not displayed) images within the cache budget, oldest first. Also applies a changed budget. */
	evictUnused(): void {
		const budget = this.deps.settings().preview.cacheMB * 1024 * 1024;
		const unused = [...this.entries.values()]
			.filter((e): e is Entry & { state: { kind: 'ready'; image: PreviewContent; bytes: number } } => e.state.kind === 'ready' && e.leases.size === 0)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		let total = unused.reduce((sum, e) => sum + e.state.bytes, 0);
		for (const e of unused) {
			if (total <= budget) break;
			total -= e.state.bytes;
			this.drop(e);
		}
	}

	private drop(entry: Entry): void {
		if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
		if (entry.state.kind === 'loading') entry.state.controller.abort();
		if (entry.state.kind === 'ready') {
			const shown = entry.state.image;
			if (!('kind' in shown) || shown.kind === 'svg') this.deps.revokeObjectURL(shown.url);
		}
		entry.settle.reject(new PreviewError('aborted'));
	}

	/** Drops everything of a connection (settings or profile changed, conflict). Callers re-render afterwards. */
	invalidateConnection(connectionId: string): void {
		this.epochs.set(connectionId, (this.epochs.get(connectionId) ?? 0) + 1);
		this.deps.credentials.invalidate(connectionId);
		for (const entry of [...this.entries.values()]) if (entry.connectionId === connectionId) this.drop(entry);
		for (const check of this.checks) if (check.connectionId === connectionId) check.controller.abort();
	}

	invalidateAll(): void {
		const ids = new Set([...this.entries.values()].map((e) => e.connectionId));
		for (const check of this.checks) ids.add(check.connectionId);
		for (const id of ids) this.invalidateConnection(id);
		this.deps.credentials.clear();
	}

	destroy(): void {
		this.destroyed = true;
		this.invalidateAll();
		for (const check of this.checks) check.controller.abort();
	}

	/** Checks that an object exists (used before inserting a reference). Cancelled together with its connection. */
	async exists(src: string, signal: AbortSignal): Promise<true> {
		if (this.destroyed) throw new PreviewError('aborted');
		const r = this.resolve(src);
		if (r instanceof PreviewError) throw r;
		const check: Check = { connectionId: r.connection.id, epoch: this.epochs.get(r.connection.id) ?? 0, controller: new AbortController() };
		const onAbort = () => check.controller.abort();
		if (signal.aborted) onAbort();
		else signal.addEventListener('abort', onAbort, { once: true });
		this.checks.add(check);
		try {
			const credentials = await this.deps.credentials.get(r.connection.id, r.generation, r.profile, r.connection.region, check.controller.signal);
			await this.deps
				.s3For(r.connection, credentials)
				.send(new HeadObjectCommand({ Bucket: r.connection.bucket, Key: r.key }), { abortSignal: check.controller.signal });
			// The answer only counts if nothing relevant changed while it was in flight.
			const now = this.resolve(src);
			if (
				this.destroyed ||
				check.controller.signal.aborted ||
				(this.epochs.get(check.connectionId) ?? 0) !== check.epoch ||
				now instanceof PreviewError ||
				now.connection.id !== r.connection.id ||
				now.generation !== r.generation
			) {
				throw new PreviewError('aborted');
			}
			return true;
		} catch (error) {
			throw toPreviewError(error);
		} finally {
			signal.removeEventListener('abort', onAbort);
			this.checks.delete(check);
		}
	}

	/** For tests and diagnostics. */
	stats(): { entries: number; ready: number; loading: number; failed: number; unusedBytes: number } {
		const all = [...this.entries.values()];
		return {
			entries: all.length,
			ready: all.filter((e) => e.state.kind === 'ready').length,
			loading: all.filter((e) => e.state.kind === 'loading').length,
			failed: all.filter((e) => e.state.kind === 'failed').length,
			unusedBytes: all.reduce((s, e) => s + (e.state.kind === 'ready' && e.leases.size === 0 ? e.state.bytes : 0), 0),
		};
	}
}

/** Releases an unread response body (Node stream or web stream). */
function discardBody(body: unknown): void {
	const b = body as { destroy?: () => void; cancel?: () => unknown } | undefined;
	if (typeof b?.destroy === 'function') b.destroy();
	else if (typeof b?.cancel === 'function') void Promise.resolve(b.cancel()).catch(() => undefined);
}

/** Reads a body while enforcing the byte limit on what is actually received. */
export async function readLimited(body: unknown, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
	if (!body) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const stream = body as AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void };
	if (typeof (stream as Partial<AsyncIterable<Uint8Array>>)[Symbol.asyncIterator] !== 'function') {
		const b = body as { transformToByteArray?: () => Promise<Uint8Array> };
		if (!b.transformToByteArray) throw new PreviewError('unknown');
		const bytes = await b.transformToByteArray();
		if (bytes.length > maxBytes) throw new PreviewError('too-large');
		return bytes;
	}
	try {
		for await (const chunk of stream) {
			if (signal.aborted) throw abortError();
			total += chunk.length;
			if (total > maxBytes) throw new PreviewError('too-large');
			chunks.push(chunk);
		}
	} catch (error) {
		stream.destroy?.();
		throw error;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.length;
	}
	return out;
}

export type { PreviewErrorCode };
