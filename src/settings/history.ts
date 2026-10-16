// Pure rules for the upload history and the private-file ledger.
// Both are merged as sets across devices; the history is then trimmed with the same rule everywhere,
// so repeated merge-and-trim converges to the same result on every device.
import type { TargetKey } from '../storage/target';
import type { DeepReadonly } from '../util/deepReadonly';
import type { HistoryEntry, UploadFormat } from './types';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FORMATS: readonly UploadFormat[] = ['png', 'jpeg', 'webp', 'gif'];

export function isSha256Hex(value: unknown): value is string {
	return typeof value === 'string' && SHA256_HEX.test(value);
}

/** Valid hashes only, sorted and deduplicated. */
export function normalizeHashes(raw: unknown): string[] {
	return [...new Set((Array.isArray(raw) ? raw : []).filter(isSha256Hex))].sort();
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';

function normalizeEntry(raw: unknown): HistoryEntry | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const e = raw as Record<string, unknown>;
	if (!isStr(e.id) || !isStr(e.target) || !isStr(e.key) || !isStr(e.converter)) return undefined;
	if (e.classification !== 'private' && e.classification !== 'public') return undefined;
	if (!isSha256Hex(e.sourceSha256) || !isSha256Hex(e.sentSha256)) return undefined;
	if (typeof e.size !== 'number' || !Number.isInteger(e.size) || e.size < 0) return undefined;
	if (!FORMATS.includes(e.format as UploadFormat)) return undefined;
	if (typeof e.at !== 'string' || Number.isNaN(Date.parse(e.at))) return undefined;
	return {
		id: e.id,
		target: e.target,
		key: e.key,
		classification: e.classification,
		sourceSha256: e.sourceSha256,
		sentSha256: e.sentSha256,
		size: e.size,
		format: e.format as UploadFormat,
		converter: e.converter,
		at: new Date(e.at).toISOString(),
	};
}

/** Newest first; equal times by id, so the order is the same on every device. */
function compareEntries(a: DeepReadonly<HistoryEntry>, b: DeepReadonly<HistoryEntry>): number {
	if (a.at !== b.at) return a.at < b.at ? 1 : -1;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Union by id across all lists (invalid entries are dropped). Not trimmed. */
export function mergeHistory(...lists: readonly unknown[]): HistoryEntry[] {
	const byId = new Map<string, HistoryEntry>();
	for (const list of lists) {
		for (const raw of Array.isArray(list) ? list : []) {
			const entry = normalizeEntry(raw);
			if (!entry) continue;
			const existing = byId.get(entry.id);
			// The same id should never carry different content; keep a deterministic choice if it does.
			if (!existing || JSON.stringify(entry) < JSON.stringify(existing)) byId.set(entry.id, entry);
		}
	}
	return [...byId.values()].sort(compareEntries);
}

/** Keeps the newest `limit` entries. Call only after the private hashes were imported. */
export function trimHistory(history: readonly HistoryEntry[], limit: number): HistoryEntry[] {
	return [...history].sort(compareEntries).slice(0, Math.max(0, limit));
}

/** Hashes of every history entry that went, or now belongs, to private storage. */
export function privateHashesOf(history: DeepReadonly<HistoryEntry[]>, privateBuckets: readonly TargetKey[]): string[] {
	const buckets = new Set(privateBuckets);
	return history.filter((e) => e.classification === 'private' || buckets.has(e.target)).flatMap((e) => [e.sourceSha256, e.sentSha256]);
}
