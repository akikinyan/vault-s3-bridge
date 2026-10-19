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
import { FILE_FORMATS, imageContentType, isImageFormat } from './fileType';

export const PENDING_STATES = ['recorded', 'putting', 'indeterminate', 'unresolved', 'done-unrecorded', 'delivered', 'stopped'] as const;
export type PendingState = (typeof PENDING_STATES)[number];
export type KeyPhase = 'candidate' | 'prepared' | 'alt';

export interface Occurrence {
	original: string;
	/** Embed or link (design 1-2). Version 1 records held embeds only. */
	kind: 'embed' | 'link';
	/** Embed: the alt text. Link: the shown text, already escaped (6-2). */
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
	/** The fixed Content-Type this item is put with (fileType.ts). */
	contentType: string;
	converter: string;
	key: string;
	altKey?: string;
	state: PendingState;
	/**
	 * An object of this item may exist: a Put had an unknown outcome, left putting without a recorded rejection,
	 * or the item reached done-unrecorded, delivered or unresolved. Never goes back to false. Blocks failure removal.
	 */
	uncertain: boolean;
	/** A Put to this item's keys was sent in some session. Never goes back to false. */
	putSent: boolean;
	/**
	 * I14 (e)(f): the object's delivery form is known to be `contentType` with no Content-Disposition (our Put
	 * succeeded, or a Head matched both). Never goes back to false. Version 1 records start without it.
	 */
	deliveryChecked: boolean;
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
export type NewPendingItem = Omit<PendingItem, 'state' | 'uncertain' | 'putSent' | 'deliveryChecked' | 'createdAt' | 'updatedAt' | 'altKey' | 'reason'>;

/** Fields a caller may change directly. putting and indeterminate have their own methods. */
export interface PendingPatch {
	key?: string;
	altKey?: string;
	phase?: KeyPhase;
	state?: Exclude<PendingState, 'putting' | 'indeterminate'>;
	reason?: string;
	/** Only ever set to true. */
	deliveryChecked?: true;
}

/** future: this device's file was written by a newer version; it is kept as is and nothing may change it (1-2). */
export type PendingStatus = 'unloaded' | 'ready' | 'damaged' | 'future';

export type PendingResult =
	| { ok: true }
	| { ok: false; reason: 'not-ready' | 'write-failed' | 'unknown-item' | 'duplicate-item' | 'not-removable' | 'wrong-state' | 'not-found' | 'damaged-file' | 'future-file' };

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

/** States in which an object of the item exists or may exist (putting is handled when the item leaves it). */
const MAY_EXIST: ReadonlySet<PendingState> = new Set(['indeterminate', 'done-unrecorded', 'delivered', 'unresolved']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';
const oneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === 'string' && (values as readonly string[]).includes(v);
const FORMATS: readonly UploadFormat[] = FILE_FORMATS;
const V1_FORMATS = ['png', 'jpeg', 'webp', 'gif'] as const;
/** The newest record file version this code writes and understands. */
export const PENDING_VERSION = 2;
/** Printable ASCII only. */
const CONTENT_TYPE = /^[\x20-\x7e]{1,200}$/;

function parseOccurrence(raw: unknown, version: 1 | 2): Occurrence | undefined {
	if (!isObj(raw) || !isStr(raw.original) || !isStr(raw.alt) || typeof raw.inTable !== 'boolean') return undefined;
	if (raw.size !== undefined && !isStr(raw.size)) return undefined;
	if (version === 2 && !oneOf(['embed', 'link'] as const, raw.kind)) return undefined;
	const o: Occurrence = { original: raw.original, kind: version === 2 ? (raw.kind as Occurrence['kind']) : 'embed', alt: raw.alt, inTable: raw.inTable };
	if (raw.size !== undefined) o.size = raw.size;
	return o;
}

/**
 * A complete, well-formed item, or undefined. States that imply a sent Put force uncertain and putSent.
 * Version 1 items (images only) are migrated (1-2): their Content-Type is Phase 3's, the delivery form was never
 * checked, and every occurrence was an embed.
 */
export function parseItem(raw: unknown, version: 1 | 2 = PENDING_VERSION): PendingItem | undefined {
	if (!isObj(raw)) return undefined;
	const r = raw;
	const strings = ['id', 'jobId', 'groupId', 'connectionId', 'target', 'notePath', 'sourcePath', 'converter', 'key', 'preparedKey', 'createdAt', 'updatedAt'] as const;
	if (!strings.every((k) => isNonEmpty(r[k]))) return undefined;
	if (!isSha256Hex(r.sourceSha256) || !isSha256Hex(r.sentSha256)) return undefined;
	if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) return undefined;
	if (!oneOf(['private', 'public'] as const, r.classification) || !oneOf(version === 1 ? V1_FORMATS : FORMATS, r.format)) return undefined;
	if (version === 2 && (!isStr(r.contentType) || !CONTENT_TYPE.test(r.contentType) || typeof r.deliveryChecked !== 'boolean')) return undefined;
	if (!oneOf(PENDING_STATES, r.state) || !oneOf(['candidate', 'prepared', 'alt'] as const, r.phase) || !oneOf(['replace', 'copy'] as const, r.apply)) return undefined;
	if (typeof r.uncertain !== 'boolean' || typeof r.putSent !== 'boolean') return undefined;
	if (r.altKey !== undefined && !isNonEmpty(r.altKey)) return undefined;
	if (r.reason !== undefined && !isStr(r.reason)) return undefined;
	if (!Array.isArray(r.occurrences)) return undefined;
	const occurrences = r.occurrences.map((o) => parseOccurrence(o, version));
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
		contentType: version === 2 ? (r.contentType as string) : isImageFormat(r.format) ? imageContentType(r.format) : '',
		converter: r.converter as string,
		key: r.key as string,
		state: r.state,
		// A record left in putting means the process ended after the Put was sent: its outcome is unknown.
		uncertain: r.uncertain || sent || MAY_EXIST.has(r.state),
		putSent: r.putSent || sent,
		deliveryChecked: version === 2 && r.deliveryChecked === true,
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

export type ParsedPendingFile = { version: 1 | 2; items: PendingItem[] } | 'future';

/**
 * All items of a record file, 'future' for a newer version (kept as is, never read further), or undefined if
 * anything in it is not understood (nothing is dropped silently).
 */
export function parsePendingFile(text: string, deviceId: string): ParsedPendingFile | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isObj(raw)) return undefined;
	if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > PENDING_VERSION) return 'future';
	if ((raw.version !== 1 && raw.version !== 2) || raw.deviceId !== deviceId || !Array.isArray(raw.items)) return undefined;
	const version = raw.version;
	const items = raw.items.map((i) => parseItem(i, version));
	if (items.some((i) => i === undefined)) return undefined;
	const list = items as PendingItem[];
	if (new Set(list.map((i) => i.id)).size !== list.length) return undefined;
	return { version, items: list };
}

/** A version 1 item as version 1 wrote it: for rewriting another device's version 1 file (1-2). */
function toV1(item: PendingItem): Record<string, unknown> {
	const { contentType: _c, deliveryChecked: _d, occurrences, ...rest } = item;
	return { ...rest, occurrences: occurrences.map(({ kind: _k, ...o }) => o) };
}

const PHASE_ORDER: readonly KeyPhase[] = ['candidate', 'prepared', 'alt'];

const serialize = (deviceId: string, items: readonly PendingItem[], version: 1 | 2 = PENDING_VERSION) =>
	JSON.stringify({ version, deviceId, items: version === 1 ? items.map(toV1) : items }, null, '\t');

export type OtherDeviceFile = { deviceId: string; count: number } | { deviceId: string; damaged: true } | { deviceId: string; future: true };


export class PendingStore {
	private state: PendingStatus = 'unloaded';
	private list: DeepReadonly<PendingItem[]> = deepFreeze([]);
	private queue: Promise<unknown> = Promise.resolve();
	/**
	 * Items whose object may exist, known in memory even when writing that fact failed. Every later write of the
	 * file persists it as uncertain, so it survives a restart.
	 */
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
			const parsed = read.kind === 'text' ? parsePendingFile(read.text, this.deviceId) : undefined;
			if (parsed === 'future') return this.become('future', []);
			// A version 1 file is migrated in memory; the next write replaces it atomically as version 2.
			return parsed ? this.become('ready', parsed.items) : this.become('damaged', []);
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
				added.push({ ...cloneData(n), state: 'recorded', uncertain: false, putSent: false, deliveryChecked: false, createdAt: at, updatedAt: at });
			}
			return [...list, ...added];
		});
	}

	/**
	 * Key changes follow 6-0 and 7-2 only: the key moves from the candidate to the prepared key before any Put,
	 * altKey is set once, and the phase only moves forward. Anything else is `wrong-state`.
	 */
	update(ids: readonly string[], patch: PendingPatch): Promise<PendingResult> {
		const p = { ...patch } as Record<string, unknown>;
		const keyChangeAllowed = (item: PendingItem) => {
			const phase = patch.phase ?? item.phase;
			if (PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(item.phase)) return false;
			if (patch.key !== undefined && patch.key !== item.key) {
				if (item.putSent || item.phase !== 'candidate' || phase !== 'prepared' || patch.key !== item.preparedKey) return false;
			}
			if (patch.altKey !== undefined && (item.altKey !== undefined || phase !== 'alt')) return false;
			if (phase === 'alt' && item.phase !== 'alt' && patch.altKey === undefined) return false;
			return true;
		};
		const marksExisting = patch.state === 'done-unrecorded' || patch.state === 'delivered' || patch.state === 'unresolved';
		// Once the caller says the object exists (or may), no failure path may delete the record, even if this write fails.
		if (marksExisting) for (const id of ids) this.unsafe.add(id);
		return this.edit(ids, (item) => ({ ...item, ...p }), { allowed: keyChangeAllowed });
	}

	/** Written right before a Put. Sets putSent itself. */
	markPutting(ids: readonly string[]): Promise<PendingResult> {
		return this.edit(ids, (item) => ({ ...item, state: 'putting', putSent: true }));
	}

	/**
	 * The Put was answered with a definite rejection (e.g. 403, 409, BadDigest, or 412 followed by a different
	 * object): it created nothing. With markPutNotStarted, the only ways to leave putting without making the
	 * item uncertain.
	 */
	markPutRejected(ids: readonly string[], reason?: string): Promise<PendingResult> {
		return this.edit(ids, (item) => ({ ...item, state: 'recorded', ...(reason === undefined ? {} : { reason }) }), {
			allowed: (item) => item.state === 'putting',
			putSettled: true,
		});
	}

	/**
	 * putting was written, but the Put was never handed to the SDK: the last check before it refused, or the job
	 * was aborted first. Only for that case; a Put that was started has an unknown outcome until answered.
	 */
	markPutNotStarted(ids: readonly string[], reason: string): Promise<PendingResult> {
		return this.edit(ids, (item) => ({ ...item, state: 'stopped', reason }), {
			allowed: (item) => item.state === 'putting',
			putSettled: true,
		});
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
	 * Failed or excluded items: only when no Put of this item can have created an object, over all sessions
	 * recorded in the item. Every Put ever sent was recorded as rejected exactly when the item is not uncertain.
	 */
	removeFailed(ids: readonly string[]): Promise<PendingResult> {
		return this.remove(ids, (item) => !item.uncertain && !this.unsafe.has(item.id) && (item.state === 'recorded' || item.state === 'stopped'));
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
				const other = await this.readOther(id);
				if (other === 'future') result.push({ deviceId: id, future: true });
				else if (other && other !== 'missing') result.push({ deviceId: id, count: other.items.length });
				else if (other === undefined) result.push({ deviceId: id, damaged: true });
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
			const read = await this.readOther(otherDeviceId);
			if (read === 'missing') return { ok: false, reason: 'not-found' } as const;
			if (read === 'future') return { ok: false, reason: 'future-file' } as const;
			if (!read) return { ok: false, reason: 'damaged-file' } as const;
			const theirs = read.items;
			const own = new Set(this.list.map((i) => i.id));
			const merged = [...(cloneData(this.list) as PendingItem[]), ...theirs.filter((i) => !own.has(i.id))];
			if (!(await this.writeOwn(merged))) return { ok: false, reason: 'write-failed' } as const;
			// Re-read: the other file may have changed since (e.g. synchronisation). Keep only what was not taken.
			const taken = new Set(theirs.map((i) => i.id));
			const now = await this.readOther(otherDeviceId);
			if (!now || now === 'missing' || now === 'future') return { ok: true } as const; // changed meanwhile: left untouched
			const rest = now.items.filter((i) => !taken.has(i.id));
			const otherName = pendingFileName(otherDeviceId);
			try {
				// Written back in the version it was read in, so an older plugin on that device can still read it.
				if (rest.length > 0) await this.io.writeAtomic(otherName, serialize(otherDeviceId, rest, now.version));
				else await this.io.unlink(otherName);
			} catch {
				// Both files now hold the taken items; ids merge them into one on the next takeover.
			}
			return { ok: true } as const;
		});
	}

	/**
	 * Discards another device's record file after the user confirmed it (7-5): removed with unlink, not moved to
	 * the vault's trash. A damaged file can be discarded too; a missing one is already gone.
	 */
	discardOther(otherDeviceId: string): Promise<PendingResult> {
		return this.enqueue(async () => {
			if (!isDeviceId(otherDeviceId) || otherDeviceId === this.deviceId) return { ok: false, reason: 'not-found' } as const;
			const name = pendingFileName(otherDeviceId);
			if ((await this.readOther(otherDeviceId)) === 'future') return { ok: false, reason: 'future-file' } as const;
			try {
				await this.io.unlink(name);
			} catch {
				if ((await this.io.read(name)).kind !== 'missing') return { ok: false, reason: 'write-failed' } as const;
			}
			return { ok: true } as const;
		});
	}

	// --- internals --------------------------------------------------------

	private async readOther(deviceId: string): Promise<ParsedPendingFile | 'missing' | undefined> {
		const read = await this.io.read(pendingFileName(deviceId));
		if (read.kind === 'missing') return 'missing';
		return read.kind === 'text' ? parsePendingFile(read.text, deviceId) : undefined;
	}

	private become(state: PendingStatus, items: PendingItem[]): PendingStatus {
		this.state = state;
		this.list = deepFreeze(items);
		// Never cleared: a mark whose write failed must survive a second load in the same session.
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
			const proposed = next(cloneData(this.list) as PendingItem[]);
			if (typeof proposed === 'string') return { ok: false, reason: proposed } as const;
			return (await this.writeOwn(proposed)) ? ({ ok: true } as const) : ({ ok: false, reason: 'write-failed' } as const);
		});
	}

	/**
	 * The only writer of this device's file. Marks as uncertain every item that memory knows may have an object
	 * (all items written, not only edited ones), writes, and only then makes the list current.
	 */
	private async writeOwn(items: PendingItem[]): Promise<boolean> {
		const result = items.map((i) => (!i.uncertain && (this.unsafe.has(i.id) || MAY_EXIST.has(i.state)) ? { ...i, uncertain: true } : i));
		try {
			await this.io.writeAtomic(this.fileName, serialize(this.deviceId, result));
		} catch {
			return false;
		}
		this.list = deepFreeze(result);
		for (const i of result) if (i.uncertain) this.unsafe.add(i.id);
		return true;
	}

	/**
	 * @param opts.allowed every item must satisfy it, otherwise nothing changes (`wrong-state`).
	 * @param opts.putSettled only markPutRejected and markPutNotStarted: leave putting without marking the item uncertain.
	 */
	private edit(
		ids: readonly string[],
		f: (item: PendingItem) => PendingItem,
		opts: { allowed?: (item: PendingItem) => boolean; putSettled?: boolean } = {},
	): Promise<PendingResult> {
		return this.change((list) => {
			const wanted = new Set(ids);
			if ([...wanted].some((id) => !list.some((i) => i.id === id))) return 'unknown-item';
			if (opts.allowed && !list.filter((i) => wanted.has(i.id)).every(opts.allowed)) return 'wrong-state';
			const at = this.now().toISOString();
			return list.map((item) => {
				if (!wanted.has(item.id)) return item;
				const next = f(item);
				// Leaving putting without a recorded rejection means the Put's outcome is unknown.
				const leftPutUnanswered = item.state === 'putting' && next.state !== 'putting' && !opts.putSettled;
				// The flags only ever grow, whatever the caller passed.
				return {
					...next,
					uncertain: item.uncertain || next.uncertain || leftPutUnanswered,
					putSent: item.putSent || next.putSent || next.state === 'putting',
					deliveryChecked: item.deliveryChecked || next.deliveryChecked,
					updatedAt: at,
				};
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
