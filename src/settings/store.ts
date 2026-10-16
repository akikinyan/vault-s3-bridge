// Single serialisation point for reading, changing and saving settings.
// Every pass re-reads data.json, merges the grow-only records with what this device already knows,
// applies at most one operation to that latest state, and saves. Ordinary settings always follow the disk.
import type { MessageKey } from '../i18n';
import { cloneData, deepFreeze, type DeepReadonly } from '../util/deepReadonly';
import { type DeviceState, type DeviceStorage, loadDeviceState, saveDeviceState } from './device';
import { mergeHistory, normalizeHashes, privateHashesOf, trimHistory } from './history';
import { loadSettings, serializeSettings, stableStringify } from './migrate';
import { mergeRecords, normalizeRecords, recordsOf, type Records } from './registry';
import { DEFAULT_SETTINGS, type PluginSettings } from './types';

export type ReadOnlyReason = 'future-version' | 'unreadable';

export interface StoreIO {
	/** Resolves to `undefined` when data.json is empty or not valid JSON, `null` when it does not exist. */
	loadData(): Promise<unknown>;
	saveData(data: Record<string, unknown>): Promise<void>;
	device: DeviceStorage;
	sleep(ms: number): Promise<void>;
	/** private-files.json beside data.json (written atomically). Omitted in tests that do not need it. */
	privateFilesBackup?: {
		/** Parsed JSON, or undefined when missing or damaged (never throws for those). */
		read(): Promise<unknown>;
		write(hashes: readonly string[]): Promise<void>;
	};
}

/** Imports the hashes of private (or reclassified) history entries, then trims the history. Order matters. */
function finalizeRecords(s: PluginSettings): PluginSettings {
	const privateFiles = normalizeHashes([...s.privateFiles, ...privateHashesOf(s.history, s.privateBuckets)]);
	return { ...s, privateFiles, history: trimHistory(s.history, s.historyLimit) };
}

export interface OpContext {
	/** Device-local state (profiles). Changes are kept only when the pass persists successfully. */
	device: DeviceState;
}

export type OpResult<T> = { ok: true; value: T } | { ok: false; error: MessageKey[] };
export type Op<T> = (draft: PluginSettings, ctx: OpContext) => OpResult<T>;

export type MutateResult<T> =
	| { ok: true; value: T; persisted: 'written' | 'unchanged'; generation: number }
	| { ok: false; error: MessageKey[]; reason: 'rejected' | 'read-only' | 'save-failed' };

/** A checkpoint callback must not return a promise: the queue moves on as soon as it returns. */
export type NotThenable<T> = T extends PromiseLike<unknown> ? never : T extends { then: unknown } ? never : T;

export interface StoreChange {
	generation: number;
	/** Connections whose profile or authentication generation changed on this device. */
	authChanged: string[];
}

/** Waits 200 ms and reads once more when data.json is unreadable (e.g. caught mid-write by a sync tool). */
export const UNREADABLE_RETRY_MS = 200;

export class SettingsStore {
	private settings: DeepReadonly<PluginSettings>;
	private deviceState: DeepReadonly<DeviceState>;
	private gen = 0;
	private reason: ReadOnlyReason | undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<(change: StoreChange) => void>();

	constructor(private readonly io: StoreIO) {
		this.settings = deepFreeze(cloneData(DEFAULT_SETTINGS));
		this.deviceState = deepFreeze(loadDeviceState(io.device));
	}

	get current(): DeepReadonly<PluginSettings> {
		return this.settings;
	}

	get device(): DeepReadonly<DeviceState> {
		return this.deviceState;
	}

	get generation(): number {
		return this.gen;
	}

	get readOnly(): ReadOnlyReason | undefined {
		return this.reason;
	}

	/** Called after every pass that changed the settings, records or device profiles. */
	subscribe(listener: (change: StoreChange) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Re-reads data.json (startup and external changes). Writes back only a migration of readable data. */
	reload(): Promise<void> {
		return this.enqueue(async () => {
			await this.pass({ kind: 'reload' });
		});
	}

	/**
	 * Applies `op` to the latest settings and saves. With `allowUnreadable`, the op also runs while
	 * data.json cannot be read in this very pass (used only by "reset and save").
	 */
	mutate<T>(op: Op<T>, opts: { allowUnreadable?: boolean } = {}): Promise<MutateResult<T>> {
		return this.enqueue(async () => {
			const r = await this.pass({ kind: 'mutate', op, allowUnreadable: opts.allowUnreadable === true });
			return r.mutate as MutateResult<T>;
		});
	}

	/**
	 * Reads and merges the latest settings, then calls `check` synchronously inside the queue.
	 * `check` starts any request itself and returns a non-promise value (e.g. `{ response }`), so the
	 * queue does not wait for the response.
	 */
	checkpoint<T>(check: (settings: DeepReadonly<PluginSettings>) => NotThenable<T>): Promise<T> {
		return this.enqueue(async () => {
			await this.pass({ kind: 'checkpoint' });
			return check(this.settings);
		});
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const run = this.queue.then(task, task);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async readDisk(): Promise<unknown> {
		const raw = await this.io.loadData();
		if (raw !== undefined) return raw;
		await this.io.sleep(UNREADABLE_RETRY_MS);
		return this.io.loadData();
	}

	private async readBackup(): Promise<string[]> {
		try {
			const raw = await this.io.privateFilesBackup?.read();
			return typeof raw === 'object' && raw !== null ? normalizeHashes((raw as { privateFiles?: unknown }).privateFiles) : [];
		} catch {
			return [];
		}
	}

	/** Writes private-files.json only when its content would change. A failure leaves data.json authoritative. */
	private async writeBackup(current: readonly string[], next: readonly string[]): Promise<void> {
		if (!this.io.privateFilesBackup || JSON.stringify(current) === JSON.stringify(next)) return;
		try {
			await this.io.privateFilesBackup.write(next);
		} catch {
			this.backupFailed = true;
		}
	}

	/** Set when private-files.json could not be written (data.json still holds the records). */
	backupFailed = false;

	private async pass(
		req: { kind: 'reload' } | { kind: 'checkpoint' } | { kind: 'mutate'; op: Op<unknown>; allowUnreadable: boolean },
	): Promise<{ mutate?: MutateResult<unknown> }> {
		// 1–3. Read, detect read-only, normalise. Ordinary settings come from the disk when it is readable.
		const raw = await this.readDisk();
		const unreadable = raw === undefined;
		const device: DeviceState = cloneData(this.deviceState) as DeviceState;
		const loaded = unreadable ? undefined : loadSettings(raw, device);
		const reason: ReadOnlyReason | undefined = unreadable ? 'unreadable' : loaded?.readOnly ? 'future-version' : undefined;
		const ordinary: PluginSettings = loaded ? loaded.settings : (cloneData(this.settings) as PluginSettings);

		// 4. Union of the grow-only records (disk, memory, device mirror, private-files.json). Not trimmed yet.
		const backup = normalizeHashes(await this.readBackup());
		const records: Records = mergeRecords(
			recordsOf(ordinary),
			recordsOf(this.settings),
			normalizeRecords(device.mirror),
			normalizeRecords({ privateFiles: backup }),
		);
		const history = mergeHistory(ordinary.history, this.settings.history);
		// The operation sees the untrimmed history; 6–7 (import, then trim) always run after it.
		const base: PluginSettings = { ...ordinary, ...records, history };
		let next: PluginSettings = finalizeRecords(base);
		let nextDevice = device;

		// 5–8. Apply the operation to the latest state, then persist.
		let mutate: MutateResult<unknown> | undefined;
		let clearReadOnly = false;
		if (req.kind === 'mutate') {
			const resetting = req.allowUnreadable && reason === 'unreadable';
			if (req.allowUnreadable && !resetting) {
				// "Reset and save" only while this very read failed: never over data that became readable.
				mutate = { ok: false, error: [], reason: 'rejected' };
			} else if (reason && !resetting) {
				mutate = { ok: false, error: [reason === 'unreadable' ? 'notice.unreadable' : 'notice.readOnly'], reason: 'read-only' };
			} else {
				const draft = cloneData(base);
				const draftDevice = cloneData(device);
				const result = req.op(draft, { device: draftDevice });
				if (!result.ok) {
					mutate = { ok: false, error: result.error, reason: 'rejected' };
				} else {
					// Records only grow, whatever the operation did. 6–7 run after the operation (reclassification).
					const candidate: PluginSettings = finalizeRecords({
						...draft,
						...mergeRecords(records, recordsOf(draft)),
						history: mergeHistory(history, draft.history),
					});
					const out = serializeSettings(candidate);
					let persisted: 'written' | 'unchanged' | undefined;
					if (!unreadable && raw !== null && stableStringify(out) === stableStringify(raw)) persisted = 'unchanged';
					else {
						try {
							await this.io.saveData(out);
							persisted = 'written';
						} catch {
							persisted = undefined;
						}
					}
					if (persisted) {
						next = candidate;
						nextDevice = draftDevice;
						clearReadOnly = resetting;
						await this.writeBackup(backup, next.privateFiles);
						mutate = { ok: true, value: result.value, persisted, generation: 0 };
					} else {
						// Not saved: drop the ordinary changes but keep every record the operation added.
						next = { ...next, ...recordsOf(candidate), history: candidate.history };
						mutate = { ok: false, error: ['notice.saveFailed'], reason: 'save-failed' };
					}
				}
			}
		} else if (req.kind === 'reload' && loaded && !reason && loaded.changed) {
			// Migration write-back of readable data (never over unreadable or newer data).
			try {
				await this.io.saveData(serializeSettings(next));
				await this.writeBackup(backup, next.privateFiles);
			} catch {
				// Kept in memory; the next save writes it.
			}
		}

		// 9. Common end: keep records, follow the disk for ordinary settings, notify on any change.
		nextDevice.mirror = recordsOf(next);
		saveDeviceState(this.io.device, nextDevice);
		this.reason = clearReadOnly ? undefined : reason;
		const authChanged = changedProfiles(this.deviceState, nextDevice);
		const settingsChanged = stableStringify(serializeSettings(next)) !== stableStringify(serializeSettings(this.settings as PluginSettings));
		if (settingsChanged) this.settings = deepFreeze(next);
		this.deviceState = deepFreeze(nextDevice);
		if (settingsChanged || authChanged.length > 0) {
			this.gen++;
			const change: StoreChange = { generation: this.gen, authChanged };
			for (const listener of [...this.listeners]) listener(change);
		}
		if (mutate?.ok) mutate.generation = this.gen;
		return { mutate };
	}
}

function changedProfiles(before: DeepReadonly<DeviceState>, after: DeviceState): string[] {
	const ids = new Set([...Object.keys(before.profiles), ...Object.keys(after.profiles)]);
	return [...ids].filter((id) => {
		const a = before.profiles[id];
		const b = after.profiles[id];
		return a?.profile !== b?.profile || a?.generation !== b?.generation;
	});
}

