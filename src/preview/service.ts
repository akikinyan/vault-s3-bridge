import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { AwsCredentialIdentity } from '@smithy/types';
import { abortError, raceAbort } from '../diagnostics/types';
import { parseReference } from '../reference/reference';
import { profileOf, type DeviceState } from '../settings/device';
import { activeConnectionFor, connectionTarget, resolveAlias } from '../settings/registry';
import type { PluginSettings, StorageConnection } from '../settings/types';
import { PreviewError, type PreviewErrorCode } from './errors';
import { FAILURE_TTL_MS, toPreviewError, type SharedCredentials } from './credentials';
import { detectImage } from './imageInfo';
import { Limiter } from './limiter';

export interface PreviewImage {
	url: string;
	width: number;
	height: number;
}

export interface Lease {
	readonly result: Promise<PreviewImage>;
	readonly released: boolean;
	release(): void;
}

export interface PreviewServiceDeps {
	settings(): PluginSettings;
	device(): DeviceState;
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

type EntryState =
	| { kind: 'loading'; controller: AbortController }
	| { kind: 'ready'; image: PreviewImage; bytes: number }
	| { kind: 'failed'; error: PreviewError; until: number };

interface Entry {
	id: string;
	connectionId: string;
	epoch: number;
	state: EntryState;
	leases: Set<LeaseImpl>;
	lastUsed: number;
	settle: { resolve(image: PreviewImage): void; reject(error: PreviewError): void; promise: Promise<PreviewImage> };
}

class LeaseImpl implements Lease {
	released = false;
	readonly result: Promise<PreviewImage>;
	private readonly controller = new AbortController();

	constructor(
		source: Promise<PreviewImage>,
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
	let resolve!: (image: PreviewImage) => void;
	let reject!: (error: PreviewError) => void;
	const promise = new Promise<PreviewImage>((res, rej) => {
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
	private destroyed = false;

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
		const signal = entry.state.controller.signal;
		const settings = this.deps.settings();
		const maxBytes = settings.preview.maxFileMB * 1024 * 1024;
		const maxPixels = settings.preview.maxMegapixels * 1_000_000;
		let url: string | undefined;
		try {
			const releaseSlot = await this.limiter.acquire(signal);
			try {
				const credentials = await this.deps.credentials.get(r.connection.id, r.generation, r.profile, r.connection.region, signal);
				const s3 = this.deps.s3For(r.connection, credentials);
				const response = await s3.send(new GetObjectCommand({ Bucket: r.connection.bucket, Key: r.key }), { abortSignal: signal });
				if ((response.ContentLength ?? 0) > maxBytes) throw new PreviewError('too-large');
				const bytes = await readLimited(response.Body, maxBytes, signal);
				const info = detectImage(bytes);
				if (info.kind === 'svg') throw new PreviewError('unsupported-svg');
				if (info.kind !== 'image') throw new PreviewError('unsupported-format');
				if (info.width * info.height > maxPixels) throw new PreviewError('too-many-pixels');
				url = this.deps.createObjectURL(new Blob([new Uint8Array(bytes)], { type: info.mime }));
				if (!this.isCurrent(entry)) {
					this.deps.revokeObjectURL(url);
					entry.settle.reject(new PreviewError('aborted'));
					return;
				}
				const image = { url, width: info.width, height: info.height };
				entry.state = { kind: 'ready', image, bytes: bytes.length };
				entry.settle.resolve(image);
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
			.filter((e): e is Entry & { state: { kind: 'ready'; image: PreviewImage; bytes: number } } => e.state.kind === 'ready' && e.leases.size === 0)
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
		if (entry.state.kind === 'ready') this.deps.revokeObjectURL(entry.state.image.url);
		entry.settle.reject(new PreviewError('aborted'));
	}

	/** Drops everything of a connection (settings or profile changed, conflict). Callers re-render afterwards. */
	invalidateConnection(connectionId: string): void {
		this.epochs.set(connectionId, (this.epochs.get(connectionId) ?? 0) + 1);
		this.deps.credentials.invalidate(connectionId);
		for (const entry of [...this.entries.values()]) if (entry.connectionId === connectionId) this.drop(entry);
	}

	invalidateAll(): void {
		for (const id of new Set([...this.entries.values()].map((e) => e.connectionId))) this.invalidateConnection(id);
		this.deps.credentials.clear();
	}

	destroy(): void {
		this.invalidateAll();
		this.destroyed = true;
	}

	/** Checks that an object exists (used before inserting a reference). */
	async exists(src: string, signal: AbortSignal): Promise<true> {
		const r = this.resolve(src);
		if (r instanceof PreviewError) throw r;
		try {
			const credentials = await this.deps.credentials.get(r.connection.id, r.generation, r.profile, r.connection.region, signal);
			await this.deps.s3For(r.connection, credentials).send(new HeadObjectCommand({ Bucket: r.connection.bucket, Key: r.key }), { abortSignal: signal });
			return true;
		} catch (error) {
			throw toPreviewError(error);
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
