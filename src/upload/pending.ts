// Resume records for uploads (pending-<deviceId>.json in the plugin folder).
// Every change goes through one write queue and is applied in memory only after the file was replaced
// atomically. A record file that cannot be read is never overwritten: the store becomes damaged instead.
import { mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeviceId } from '../settings/device';
import { isSha256Hex } from '../settings/history';
import type { Classification, UploadFormat } from '../settings/types';
import type { TargetKey } from '../storage/target';
import { writeFileAtomic } from '../util/atomicFile';
import { cloneData, deepFreeze, type DeepReadonly } from '../util/deepReadonly';

export const PENDING_STATES = ['recorded', 'putting', 'indeterminate', 'unresolved', 'done-unrecorded', 'delivered', 'stopped'] as const;
export type PendingState = (typeof PENDING_STATES)[number];
export type KeyPhase = 'candidate' | 'prepared' | 'alt';

export interface Occurrence {
	original: string;
	alt: string;
	size?: string;
	inTable: boolean;
}

export interface PendingItem {
	id: string;
	jobId: string;
	/** Items of one send group share key and altKey. */
	groupId: string;
	connectionId: string;
	target: TargetKey;
	classification: Classification;
	notePath: string;
	sourcePath: string;
	sourceSha256: string;
	sentSha256: string;
	size: number;
	format: UploadFormat;
	converter: string;
	key: string;
	altKey?: string;
	state: PendingState;
	/** A Put to this item's keys once had an unknown outcome. Never goes back to false. */
	uncertain: boolean;
	/** A Put to this item's keys was sent in some session. Never goes back to false. */
	putSent: boolean;
	preparedKey: string;
	phase: KeyPhase;
	occurrences: Occurrence[];
	apply: 'replace' | 'copy';
	/** A classification only (e.g. an HTTP status), never raw request or response data. */
	reason?: string;
	createdAt: string;
	updatedAt: string;
}

/** What the caller supplies for a new record; state, flags and times are set by the store. */
export type NewPendingItem = Omit<PendingItem, 'state' | 'uncertain' | 'putSent' | 'createdAt' | 'updatedAt' | 'altKey' | 'reason'>;

/** Fields a caller may change directly. putting and indeterminate have their own methods. */
export interface PendingPatch {
	key?: string;
	altKey?: string;
	phase?: KeyPhase;
	state?: Exclude<PendingState, 'putting' | 'indeterminate'>;
	reason?: string;
}

export type PendingStatus = 'unloaded' | 'ready' | 'damaged';

export type PendingResult =
	| { ok: true }
	| { ok: false; reason: 'not-ready' | 'write-failed' | 'unknown-item' | 'duplicate-item' | 'not-removable' | 'not-found' | 'damaged-file' };

type PendingFailure = Extract<PendingResult, { ok: false }>['reason'];

/** Missing is distinct from unreadable: only a missing file may be treated as empty. */
export type ReadOutcome = { kind: 'missing' } | { kind: 'text'; text: string } | { kind: 'error' };

export interface PendingIO {
	read(name: string): Promise<ReadOutcome>;
	writeAtomic(name: string, text: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	unlink(name: string): Promise<void>;
	/** File names in the plugin folder. */
	list(): Promise<string[]>;
}

const OWN_FILE = /^pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

export function pendingFileName(deviceId: string): string {
	if (!isDeviceId(deviceId)) throw new Error('invalid device id');
	return `pending-${deviceId}.json`;
}

/** The device id of a record file name, or undefined for anything else (temporary files, set-aside copies). */
export function deviceIdOfFile(name: string): string | undefined {
	return OWN_FILE.exec(name)?.[1];
}

/** Plugin-folder IO with Node's fs. Atomic writes use a temporary file, fsync and rename. */
export function nodePendingIO(dir: string): PendingIO {
	return {
		async read(name) {
			try {
				return { kind: 'text', text: await readFile(join(dir, name), 'utf8') };
			} catch (error) {
				return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error' };
			}
		},
		async writeAtomic(name, text) {
			await mkdir(dir, { recursive: true });
			await writeFileAtomic(join(dir, name), text);
		},
		rename: (from, to) => rename(join(dir, from), join(dir, to)),
		// Plugin-internal file: removed directly, not moved to the vault's trash.
		unlink: (name) => unlink(join(dir, name)),
		list: async () => {
			try {
				return await readdir(dir);
			} catch {
				return [];
			}
		},
	};
}

// --- validation -------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
const FORMATS: readonly UploadFormat[] = ['png', 'jpeg', 'webp', 'gif'];

function parseOccurrence(raw: unknown): Occurrence | undefined {
	if (!isObj(raw) || !isStr(raw.original) || !isStr(raw.alt) || typeof raw.inTable !== 'boolean') return undefined;
	if (raw.size !== undefined && !isStr(raw.size)) return undefined;
	const o: Occurrence = { original: raw.original, alt: raw.alt, inTable: raw.inTable };
	if (raw.size !== undefined) o.size = raw.size;
	return o;
}

/** A complete, well-formed item, or undefined. States that imply a sent Put force uncertain and putSent. */
export function parseItem(raw: unknown): PendingItem | undefined {
	if (!isObj(raw)) return undefined;
	const r = raw;
	const strings = ['id', 'jobId', 'groupId', 'connectionId', 'target', 'notePath', 'sourcePath', 'converter', 'key', 'preparedKey', 'createdAt', 'updatedAt'] as const;
	if (!strings.every((k) => isNonEmpty(r[k]))) return undefined;
	if (!isSha256Hex(r.sourceSha256) || !isSha256Hex(r.sentSha256)) return undefined;
	if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) return undefined;
	if (!oneOf(['private', 'public'] as const, r.classification) || !oneOf(FORMATS, r.format)) return undefined;
	if (!oneOf(PENDING_STATES, r.state) || !oneOf(['candidate', 'prepared', 'alt'] as const, r.phase) || !oneOf(['replace', 'copy'] as const, r.apply)) return undefined;
	if (typeof r.uncertain !== 'boolean' || typeof r.putSent !== 'boolean') return undefined;
	if (r.altKey !== undefined && !isNonEmpty(r.altKey)) return undefined;
	if (r.reason !== undefined && !isStr(r.reason)) return undefined;
	if (!Array.isArray(r.occurrences)) return undefined;
	const occurrences = r.occurrences.map(parseOccurrence);
	if (occurrences.some((o) => o === undefined)) return undefined;
	const sent = r.state === 'putting' || r.state === 'indeterminate';
	const item: PendingItem = {
		id: r.id as string,
		jobId: r.jobId as string,
		groupId: r.groupId as string,
		connectionId: r.connectionId as string,
		target: r.target as string,
		classification: r.classification,
		notePath: r.notePath as string,
		sourcePath: r.sourcePath as string,
		sourceSha256: r.sourceSha256,
		sentSha256: r.sentSha256,
		size: r.size,
		format: r.format,
		converter: r.converter as string,
		key: r.key as string,
		state: r.state,
		// A record left in putting means the process ended after the Put was sent: its outcome is unknown.
		uncertain: r.uncertain || sent,
		putSent: r.putSent || sent,
		preparedKey: r.preparedKey as string,
		phase: r.phase,
		occurrences: occurrences as Occurrence[],
		apply: r.apply,
		createdAt: r.createdAt as string,
		updatedAt: r.updatedAt as string,
	};
	if (r.altKey !== undefined) item.altKey = r.altKey;
	if (r.reason !== undefined) item.reason = r.reason;
	return item;
}

/** All items of a record file, or undefined if anything in it is not understood (nothing is dropped silently). */
export function parsePendingFile(text: string, deviceId: string): PendingItem[] | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObj(raw) || raw.version !== 1 || raw.deviceId !== deviceId || !Array.isArray(raw.items)) return undefined;
	const items = raw.items.map(parseItem);
	if (items.some((i) => i === undefined)) return undefined;
	const list = items as PendingItem[];
	if (new Set(list.map((i) => i.id)).size !== list.length) return undefined;
	return list;
}

const serialize = (deviceId: string, items: readonly PendingItem[]) => JSON.stringify({ version: 1, deviceId, items }, null, '\t');

export type OtherDeviceFile = { deviceId: string; count: number } | { deviceId: string; damaged: true };

/** How a failed or excluded item may prove that its Put did not create an object (7-2). */
export type FailureEvidence = 'no-put' | 'put-rejected';

export class PendingStore {
	private state: PendingStatus = 'unloaded';
	private list: DeepReadonly<PendingItem[]> = deepFreeze([]);
	private queue: Promise<unknown> = Promise.resolve();
	/** Items whose object may exist, kept in memory even when writing that fact to disk failed. */
	private readonly unsafe = new Set<string>();
	private readonly fileName: string;

	constructor(
		private readonly io: PendingIO,
		readonly deviceId: string,
		private readonly now: () => Date = () => new Date(),
	) {
		this.fileName = pendingFileName(deviceId);
	}

	get status(): PendingStatus {
		return this.state;
	}

	get items(): DeepReadonly<PendingItem[]> {
		return this.list;
	}

	/** Reads this device's file. A missing file is empty; any other problem makes the store damaged (read-only). */
	load(): Promise<PendingStatus> {
		return this.enqueue(async () => {
			const read = await this.io.read(this.fileName);
			if (read.kind === 'missing') return this.become('ready', []);
			const items = read.kind === 'text' ? parsePendingFile(read.text, this.deviceId) : undefined;
			return items ? this.become('ready', items) : this.become('damaged', []);
		});
	}

	/** Saves new items in one write: either all of them are recorded or none (a send group is all-or-nothing). */
	add(items: readonly NewPendingItem[]): Promise<PendingResult> {
		return this.change((list) => {
			const ids = new Set(list.map((i) => i.id));
			const at = this.now().toISOString();
			const added: PendingItem[] = [];
			for (const n of items) {
				if (ids.has(n.id)) return 'duplicate-item';
				ids.add(n.id);
				added.push({ ...cloneData(n), state: 'recorded', uncertain: false, putSent: false, createdAt: at, updatedAt: at });
			}
			return [...list, ...added];
		});
	}

	update(ids: readonly string[], patch: PendingPatch): Promise<PendingResult> {
		const p = { ...patch } as Record<string, unknown>;
		const marksExisting = patch.state === 'done-unrecorded' || patch.state === 'delivered' || patch.state === 'unresolved';
		// Once the caller says the object exists (or may), no failure path may delete the record, even if this write fails.
		if (marksExisting) for (const id of ids) this.unsafe.add(id);
		return this.edit(ids, (item) => ({ ...item, ...p }));
	}

	/** Written right before a Put. Sets putSent itself. */
	markPutting(ids: readonly string[]): Promise<PendingResult> {
		return this.edit(ids, (item) => ({ ...item, state: 'putting', putSent: true }));
	}

	/** The Put's outcome is unknown. The item is treated as uncertain in memory even if this write fails. */
	markIndeterminate(ids: readonly string[], reason?: string): Promise<PendingResult> {
		for (const id of ids) this.unsafe.add(id);
		return this.edit(ids, (item) => ({ ...item, state: 'indeterminate', uncertain: true, putSent: true, ...(reason === undefined ? {} : { reason }) }));
	}

	/** Normal completion: history saved and the note updated (or the Markdown copied). */
	removeCompleted(ids: readonly string[]): Promise<PendingResult> {
		return this.remove(ids, (item) => item.state === 'delivered');
	}

	/**
	 * Failed or excluded items: only when no Put of this item can have created an object, judged over all
	 * sessions recorded in the item. A putting item needs the caller's proof that this Put was rejected.
	 */
	removeFailed(ids: readonly string[], evidence: FailureEvidence): Promise<PendingResult> {
		return this.remove(ids, (item) => {
			if (item.uncertain || this.unsafe.has(item.id)) return false;
			if (item.state === 'putting') return evidence === 'put-rejected';
			return item.state === 'recorded' || item.state === 'stopped';
		});
	}

	/** The user confirmed discarding the records (the UI warns that objects may remain). */
	removeDiscarded(ids: readonly string[]): Promise<PendingResult> {
		return this.remove(ids, () => true);
	}

	/**
	 * Leaves the damaged state after the user confirmed it: the unreadable file is set aside (not deleted) under
	 * a name that still matches `pending-*.json` but is never read as a record file, and the store starts empty.
	 */
	resetDamaged(): Promise<PendingResult> {
		return this.enqueue(async () => {
			if (this.state !== 'damaged') return { ok: false, reason: 'not-ready' } as const;
			const stamp = this.now().toISOString().replace(/[:.]/g, '-');
			try {
				await this.io.rename(this.fileName, `pending-${this.deviceId}.damaged-${stamp}.json`);
			} catch {
				const read = await this.io.read(this.fileName);
				if (read.kind !== 'missing') return { ok: false, reason: 'write-failed' } as const;
			}
			this.become('ready', []);
			return { ok: true } as const;
		});
	}

	/** Record files of other devices (or of this vault before the device id changed). Never used automatically. */
	others(): Promise<OtherDeviceFile[]> {
		return this.enqueue(async () => {
			const result: OtherDeviceFile[] = [];
			for (const name of (await this.io.list()).sort()) {
				const id = deviceIdOfFile(name);
				if (!id || id === this.deviceId) continue;
				const items = await this.readOther(id);
				result.push(items ? { deviceId: id, count: items.length } : { deviceId: id, damaged: true });
			}
			return result;
		});
	}

	/**
	 * Takes over another device's records (7-5): merge (own item wins on the same id), save own file, and only
	 * then rewrite the other file without the taken items (deleted when empty).
	 */
	takeOver(otherDeviceId: string): Promise<PendingResult> {
		return this.enqueue(async () => {
			if (this.state !== 'ready') return { ok: false, reason: 'not-ready' } as const;
			if (!isDeviceId(otherDeviceId) || otherDeviceId === this.deviceId) return { ok: false, reason: 'not-found' } as const;
			const theirs = await this.readOther(otherDeviceId);
			if (theirs === 'missing') return { ok: false, reason: 'not-found' } as const;
			if (!theirs) return { ok: false, reason: 'damaged-file' } as const;
			const own = new Set(this.list.map((i) => i.id));
			const merged = [...(cloneData(this.list) as PendingItem[]), ...theirs.filter((i) => !own.has(i.id))];
			try {
				await this.io.writeAtomic(this.fileName, serialize(this.deviceId, merged));
			} catch {
				return { ok: false, reason: 'write-failed' } as const;
			}
			this.list = deepFreeze(merged);
			// Re-read: the other file may have changed since (e.g. synchronisation). Keep only what was not taken.
			const taken = new Set(theirs.map((i) => i.id));
			const now = await this.readOther(otherDeviceId);
			if (!Array.isArray(now)) return { ok: true } as const; // gone, or damaged meanwhile: left untouched
			const rest = now.filter((i) => !taken.has(i.id));
			const otherName = pendingFileName(otherDeviceId);
			try {
				if (rest.length > 0) await this.io.writeAtomic(otherName, serialize(otherDeviceId, rest));
				else await this.io.unlink(otherName);
			} catch {
				// Both files now hold the taken items; ids merge them into one on the next takeover.
			}
			return { ok: true } as const;
		});
	}

	// --- internals --------------------------------------------------------

	private async readOther(deviceId: string): Promise<PendingItem[] | 'missing' | undefined> {
		const read = await this.io.read(pendingFileName(deviceId));
		if (read.kind === 'missing') return 'missing';
		return read.kind === 'text' ? parsePendingFile(read.text, deviceId) : undefined;
	}

	private become(state: PendingStatus, items: PendingItem[]): PendingStatus {
		this.state = state;
		this.list = deepFreeze(items);
		this.unsafe.clear();
		for (const i of items) if (i.uncertain) this.unsafe.add(i.id);
		return state;
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** Computes the next list from the current one, writes it, and only then makes it current. */
	private change(next: (list: PendingItem[]) => PendingItem[] | PendingFailure): Promise<PendingResult> {
		return this.enqueue(async () => {
			if (this.state !== 'ready') return { ok: false, reason: 'not-ready' } as const;
			const result = next(cloneData(this.list) as PendingItem[]);
			if (typeof result === 'string') return { ok: false, reason: result } as const;
			try {
				await this.io.writeAtomic(this.fileName, serialize(this.deviceId, result));
			} catch {
				return { ok: false, reason: 'write-failed' } as const;
			}
			this.list = deepFreeze(result);
			return { ok: true } as const;
		});
	}

	private edit(ids: readonly string[], f: (item: PendingItem) => PendingItem): Promise<PendingResult> {
		return this.change((list) => {
			const wanted = new Set(ids);
			if ([...wanted].some((id) => !list.some((i) => i.id === id))) return 'unknown-item';
			const at = this.now().toISOString();
			return list.map((item) => {
				if (!wanted.has(item.id)) return item;
				const next = f(item);
				// The flags only ever grow, whatever the caller passed.
				return { ...next, uncertain: item.uncertain || next.uncertain, putSent: item.putSent || next.putSent, updatedAt: at };
			});
		});
	}

	private remove(ids: readonly string[], allowed: (item: PendingItem) => boolean): Promise<PendingResult> {
		return this.change((list) => {
			const wanted = new Set(ids);
			const targets = list.filter((i) => wanted.has(i.id));
			if (targets.length !== wanted.size) return 'unknown-item';
			if (!targets.every(allowed)) return 'not-removable';
			return list.filter((i) => !wanted.has(i.id));
		});
	}
}
