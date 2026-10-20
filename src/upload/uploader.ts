// Sends one send group (design 6-0 to 6-6): the items that share a target and sentSha256 within a job.
// The transition rules live in transitions.ts; this module performs them in the order 7-2 and 10-3 require:
// records are written before each request, and every request is started inside a settings checkpoint.
import type { HeadObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';
import { connectionState, connectionTarget } from '../settings/registry';
import { addPrivateFilesOp, appendHistoryOp } from '../settings/ops';
import type { SettingsStore } from '../settings/store';
import type { HistoryEntry, PluginSettings } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import { publicUseOf } from './fileType';
import { alternateKey } from './key';
import type { NewPendingItem, PendingItem, PendingStore } from './pending';
import { classifyS3Outcome, compareHead, type HeadContent, type HeadOutcome, headCommand, PUT_MIN_TIMEOUT_MS, putCommand } from './s3';
import { afterHead, afterPut, type HeadStage, type Mode, type Next, type PutResult, resumePlan } from './transitions';

export type ItemOutcome =
	/** History saved; the item waits for the note to be updated (or the Markdown copied). */
	| 'delivered'
	/** The object exists but saving the history failed; the record stays. */
	| 'done-unrecorded'
	| 'stopped'
	| 'unresolved'
	/** The Put's outcome is still unknown; the record stays for a later resume. */
	| 'indeterminate'
	/** Failed with nothing created; the record was removed. */
	| 'failed'
	/** Left out of the group (I1 not saved, source changed); removed or kept as 7-2 decides. */
	| 'excluded'
	/** The records could not be written; nothing was sent for these items. */
	| 'not-recorded';

export interface ItemResult {
	id: string;
	outcome: ItemOutcome;
	reason?: string;
	/** The key the object is at (delivered, done-unrecorded). */
	key?: string;
}

export interface UploaderDeps {
	pending: PendingStore;
	settings: Pick<SettingsStore, 'checkpoint' | 'mutate'>;
	client: Pick<S3Client, 'send'>;
	/** Job abort, authentication change, plugin unload. A request stopped by it is ours (6-2 row 1). */
	signal: AbortSignal;
	/** network.timeoutMs; a Put gets at least PUT_MIN_TIMEOUT_MS. */
	timeoutMs: number;
	/**
	 * Job-level conditions checked synchronously inside every checkpoint (10-3 items 1 to 3 beyond what the
	 * uploader checks itself: read-only, connection settings and authentication generation as confirmed).
	 * Returns a stop reason, or undefined to go ahead.
	 */
	check(settings: DeepReadonly<PluginSettings>): string | undefined;
	/** 10-2: the source file still has the hash it had when prepared. */
	sourceUnchanged(item: DeepReadonly<PendingItem>): Promise<boolean>;
	/** 10-2: the vault reported a change of the source since preparing. Asked synchronously as a Put starts. */
	sourceChanged(item: DeepReadonly<PendingItem>): boolean;
	/**
	 * 6-5 step 2 and design 3-3: the bytes to send, made again from the sources. Undefined ('cannot-rebuild') if a
	 * source, the converter or sentSha256 differ; a refusal names a check of design 3-7 or 3-3 that failed.
	 */
	rebuild(items: readonly DeepReadonly<PendingItem>[]): Promise<Uint8Array | RebuildRefusal | undefined>;
	/**
	 * Design 4-1: the user confirmed this public item for these bytes. Without it no Put carries an item whose
	 * format needs confirming (I15); Heads are not affected.
	 */
	isConfirmed?(item: DeepReadonly<PendingItem>): boolean;
	sleep(ms: number, signal: AbortSignal): Promise<void>;
	random(): number;
	now(): Date;
	newId(): string;
}

/** Design 3-7: the rebuilt bytes are not the recorded format; 3-3: the source is over the limit when read. */
export type RebuildRefusal = 'format-changed' | 'too-large';

/** Refusal reason inside the uploader only: a source changed right before a Put. */
const SOURCE_CHANGED = 'source-changed';

const REBUILD_FAILURES: ReadonlySet<string> = new Set(['cannot-rebuild', 'format-changed', 'too-large']);

type Started<T> = { started: true; response: Promise<T> } | { started: false; reason: string };

class Group {
	/** Items still taking part. Excluded items keep their own result. */
	private live: string[];
	private readonly results = new Map<string, ItemResult>();
	private privateSaved = new Set<string>();
	private bytes: Uint8Array | undefined;
	private mode: Mode;
	private recovered = false;
	/** The last Put was refused with 404: the bucket does not exist. */
	private putNotFound = false;
	/** Bucket of the connection that passed the last checkpoint; the request is built with it. */
	private bucket = '';
	/** sourceSha256 of every item the group started with, excluded ones included (I2 covers them all, 6-0). */
	private readonly sources: string[];

	constructor(
		private readonly deps: UploaderDeps,
		ids: readonly string[],
		mode: Mode,
		bytes: Uint8Array | undefined,
		/** Started by this job (sendGroup), not resumed from a record. */
		private readonly fresh = false,
	) {
		this.live = [...ids];
		this.mode = mode;
		this.bytes = bytes;
		this.sources = this.items().map((i) => i.sourceSha256);
	}

	private items(): DeepReadonly<PendingItem>[] {
		const all = this.deps.pending.items;
		return this.live.map((id) => all.find((i) => i.id === id)).filter((i): i is DeepReadonly<PendingItem> => i !== undefined);
	}

	private first(): DeepReadonly<PendingItem> {
		const item = this.items()[0];
		if (!item) throw new Error('empty group');
		return item;
	}

	private key(): string {
		const f = this.first();
		return f.altKey ?? f.key;
	}

	private settle(ids: readonly string[], outcome: ItemOutcome, reason?: string, key?: string): void {
		for (const id of ids) this.results.set(id, { id, outcome, ...(reason === undefined ? {} : { reason }), ...(key === undefined ? {} : { key }) });
		this.live = this.live.filter((id) => !ids.includes(id));
	}

	finish(): ItemResult[] {
		return [...this.results.values()];
	}

	// --- conditions -------------------------------------------------------

	/**
	 * 10-3: everything checked synchronously right before a request starts. Design 3-5: a Head creates nothing and
	 * returns no URL, so the public format rule applies to Puts only; the delivery check is never required here.
	 */
	private refusal(settings: DeepReadonly<PluginSettings>, op: 'head' | 'put'): string | undefined {
		if (this.deps.signal.aborted) return 'aborted';
		const job = this.deps.check(settings);
		if (job) return job;
		const items = this.items();
		for (const item of items) {
			const c = settings.connections.find((x) => x.id === item.connectionId);
			if (!c || connectionState(settings, c) !== 'active') return 'connection-changed';
			if (connectionTarget(c) !== item.target || c.classification !== item.classification) return 'connection-changed';
			if (item.classification === 'private' && !this.privateSaved.has(item.id)) return 'private-not-saved';
			this.bucket = c.bucket;
		}
		// I2: a public group sends nothing if any of its files is recorded as private.
		if (items[0]?.classification === 'public') {
			const recorded = new Set(settings.privateFiles);
			if (recorded.has(items[0].sentSha256) || this.sources.some((h) => recorded.has(h))) return 'private-recorded';
			// I14 (a)-(c): a format that may never be public is never put there, whatever led to this Put.
			if (op === 'put' && items.some((i) => publicUseOf(i.format) === 'reject')) return 'public-format';
			// I15: a Put carries only items the user confirmed for these bytes (checked here as well as on screen).
			if (op === 'put' && items.some((i) => publicUseOf(i.format) === 'confirm' && this.deps.isConfirmed?.(i) !== true)) return 'needs-confirmation';
		}
		return undefined;
	}

	/** Starts the request inside the checkpoint, without any await between the checks and send(). */
	private start<T>(op: 'head' | 'put', send: () => Promise<T>, more: () => string | undefined = () => undefined): Promise<Started<T>> {
		return this.deps.settings
			.checkpoint((settings) => {
				const reason = this.refusal(settings, op) ?? more();
				if (reason) return { started: false as const, reason };
				try {
					return { started: true as const, response: send() };
				} catch {
					return { started: false as const, reason: 'request-error' };
				}
			})
			.catch(() => ({ started: false as const, reason: 'settings-error' }));
	}

	/** I1 for every private item, each saved on its own; items whose save fails leave the group. */
	async savePrivate(): Promise<void> {
		for (const item of this.items()) {
			if (item.classification !== 'private') continue;
			const r = await this.deps.settings.mutate(addPrivateFilesOp([item.sourceSha256, item.sentSha256]));
			if (r.ok) this.privateSaved.add(item.id);
			else await this.exclude(item, 'private-not-saved');
		}
	}

	/**
	 * Design 4-2: right before any Put (send or recover mode), items whose format needs confirming in public storage
	 * and that the user did not confirm leave the group. A Head could reuse an object for them; a Put cannot.
	 */
	private async dropUnconfirmed(): Promise<boolean> {
		const out = this.items().filter((i) => i.classification === 'public' && publicUseOf(i.format) === 'confirm' && this.deps.isConfirmed?.(i) !== true);
		if (out.length === 0) return true;
		const kept: string[] = [];
		for (const item of out) {
			const removed = await this.deps.pending.removeIfNeverSent([item.id]);
			if (removed.ok) this.settle([item.id], 'excluded', 'needs-confirmation');
			else if (removed.reason === 'not-removable') kept.push(item.id);
			else return false;
		}
		if (kept.length === 0) return true;
		// 4-5: a record that may have created an object stays, in a new group so it can be resumed by itself. If that
		// cannot be written, nothing is put: the record would stay in this group and be passed over once it is done.
		if (!(await this.deps.pending.setAsideUnconfirmed(kept, this.deps.newId())).ok) return false;
		this.settle(kept, 'stopped', 'needs-confirmation');
		return true;
	}

	/** 10-2 before checking and putting in send mode: changed sources leave the group. */
	private async dropChanged(): Promise<void> {
		if (this.mode !== 'send') return;
		for (const item of this.items()) if (!(await this.deps.sourceUnchanged(item))) await this.exclude(item, 'changed');
	}

	/**
	 * 6-6: a source that changed after a Put went out leaves an object that may hold the old content: unresolved.
	 * Otherwise (I1 not saved, source changed before any Put) the record goes when 7-2 allows it, else it stops.
	 */
	private async exclude(item: DeepReadonly<PendingItem>, reason: 'changed' | 'private-not-saved'): Promise<void> {
		if (reason === 'changed' && item.putSent) {
			await this.deps.pending.update([item.id], { state: 'unresolved', reason });
		} else if (!(await this.deps.pending.removeFailed([item.id])).ok) {
			await this.deps.pending.update([item.id], { state: 'stopped', reason });
		}
		this.settle([item.id], 'excluded', reason);
	}

	// --- requests ---------------------------------------------------------

	private async head(): Promise<{ stopped: string } | { result: HeadContent | HeadOutcome }> {
		const sent = this.first().sentSha256;
		const key = this.key();
		const started = await this.start<HeadObjectCommandOutput>('head', () =>
			this.deps.client.send(headCommand(this.bucket, key), { abortSignal: this.deps.signal, requestTimeout: this.deps.timeoutMs }),
		);
		if (!started.started) return { stopped: started.reason };
		// I14 (e): a public object is reused only if it is also served the way we would put it.
		const f = this.first();
		const expect = f.classification === 'public' ? { contentType: f.contentType } : undefined;
		try {
			return { result: compareHead(await started.response, sent, expect) };
		} catch (error) {
			return { result: classifyS3Outcome('head', error, this.deps.signal.aborted).outcome };
		}
	}

	/**
	 * putting is written first; a Put the checkpoint refused is recorded as never started. A source reported
	 * changed while putting was written stops the Put too (10-2): the group goes back to before it, and the
	 * loop leaves the file out.
	 */
	private async put(): Promise<{ stopped: string; settled: boolean } | { result: PutResult } | { changed: true }> {
		if (!this.bytes) {
			// A resumed group (6-5 step 2), or other files, whose bytes are read right before the first Put (3-3).
			// Once made they are kept until the group ends: retries, the alternate key and a recovery reuse them.
			const rebuilt = await this.deps.rebuild(this.items());
			if (!(rebuilt instanceof Uint8Array)) return { stopped: rebuilt ?? 'cannot-rebuild', settled: false };
			this.bytes = rebuilt;
		}
		const body = this.bytes;
		const f = this.first();
		const key = this.key();
		const ids = [...this.live];
		if (!(await this.deps.pending.markPutting(ids)).ok) return { stopped: 'record-failed', settled: false };
		const started = await this.start(
			'put',
			() =>
				this.deps.client.send(putCommand(this.bucket, key, body, f.sentSha256, f.contentType), {
					abortSignal: this.deps.signal,
					requestTimeout: Math.max(this.deps.timeoutMs, PUT_MIN_TIMEOUT_MS),
				}),
			() => (this.items().some((i) => this.deps.sourceChanged(i)) ? SOURCE_CHANGED : undefined),
		);
		if (!started.started && started.reason === SOURCE_CHANGED) {
			// Nothing was handed to the SDK. The changed files end as a refused Put does (not uncertain) and leave
			// the group; the others go back to before putting and are sent by the next round.
			const changed = this.items().filter((i) => this.deps.sourceChanged(i)).map((i) => i.id);
			const rest = ids.filter((id) => !changed.includes(id));
			if (!(await this.deps.pending.markPutNotStarted(changed, 'changed')).ok) return { stopped: 'record-failed', settled: false };
			await this.deps.pending.removeFailed(changed);
			this.settle(changed, 'excluded', 'changed');
			if (rest.length > 0 && !(await this.deps.pending.markPutRejected(rest)).ok) return { stopped: 'record-failed', settled: false };
			return { changed: true };
		}
		if (!started.started) {
			await this.deps.pending.markPutNotStarted(ids, started.reason);
			this.settle(ids, 'stopped', started.reason);
			return { stopped: started.reason, settled: true };
		}
		try {
			await started.response;
			return { result: 'ok' };
		} catch (error) {
			const c = classifyS3Outcome('put', error, this.deps.signal.aborted);
			this.putNotFound = c.outcome === 'failed' && c.httpStatus === 404;
			return { result: c.outcome };
		}
	}

	// --- the loop ---------------------------------------------------------

	async run(stage: HeadStage | 'put'): Promise<void> {
		let attempts = { conflict: 0, digest: 0 };
		let lastPut: PutResult | undefined;
		for (;;) {
			if (this.live.length === 0) return;
			let next: Next;
			if (stage === 'put') {
				if (!(await this.dropUnconfirmed())) return this.stop('record-failed');
				if (this.live.length === 0) return;
				await this.dropChanged();
				if (this.live.length === 0) return;
				const r = await this.put();
				if ('changed' in r) continue;
				if ('stopped' in r) {
					if (r.settled) return;
					// Design 3-3 with 6-6: a source of this job that no longer gives the prepared bytes before any Put
					// went out is a change before sending, as dropChanged finds it, not an unresolved record.
					if (this.fresh && r.stopped === 'cannot-rebuild') {
						for (const item of this.items()) await this.exclude(item, 'changed');
						return;
					}
					return REBUILD_FAILURES.has(r.stopped) ? this.unresolved(r.stopped) : this.stop(r.stopped);
				}
				lastPut = r.result;
				if (r.result === 'conflict') attempts = { ...attempts, conflict: attempts.conflict + 1 };
				if (r.result === 'digest') attempts = { ...attempts, digest: attempts.digest + 1 };
				next = afterPut(this.mode, r.result, attempts, () => this.deps.random());
			} else {
				if (stage === 'candidate' || stage === 'fresh') await this.dropChanged();
				if (this.live.length === 0) return;
				const r = await this.head();
				if ('stopped' in r) return this.stop(r.stopped);
				next = afterHead(stage, r.result);
			}

			switch (next.do) {
				case 'reuse':
					// A public Head matched the Content-Type too (I14 (e)); a private one checked the bytes only.
					return this.succeed(this.first().classification === 'public');
				case 'uploaded':
					// Our own Put: the object is served exactly as we put it.
					return this.succeed(true);
				case 'put':
					stage = 'put';
					break;
				case 'drop-candidate': {
					const f = this.first();
					if (!(await this.deps.pending.update([...this.live], { key: f.preparedKey, phase: 'prepared' })).ok) return this.stop('record-failed');
					stage = 'fresh';
					break;
				}
				case 'collision': {
					const f = this.first();
					if (this.mode !== 'send' || f.phase === 'alt') return this.fail('collision');
					const alt = alternateKey(f.key, f.sentSha256);
					if (!alt.ok) return this.fail('collision');
					// After 412 + Head with other content, our Put was rejected: record that before moving on.
					if (f.state === 'putting' && !(await this.deps.pending.markPutRejected([...this.live], 'collision')).ok) return this.stop('record-failed');
					if (!(await this.deps.pending.update([...this.live], { altKey: alt.key, phase: 'alt' })).ok) return this.fail('collision');
					attempts = { conflict: 0, digest: 0 };
					stage = 'fresh';
					break;
				}
				case 'resend-check': {
					// Design 3-3: a recovery within this group sends the bytes it already holds, if no source changed.
					if (this.bytes) {
						for (const item of this.items()) if (!(await this.deps.sourceUnchanged(item))) return this.unresolved('cannot-rebuild');
						stage = 'put';
						break;
					}
					const rebuilt = await this.deps.rebuild(this.items());
					if (!(rebuilt instanceof Uint8Array)) return this.unresolved(rebuilt ?? 'cannot-rebuild');
					this.bytes = rebuilt;
					stage = 'put';
					break;
				}
				case 'verify':
					stage = this.mode === 'send' ? 'verify' : 'recover-verify';
					break;
				case 'retry': {
					const ids = [...this.live];
					if (!(await this.deps.pending.markPutRejected(ids, lastPut === 'digest' ? 'digest' : 'conflict')).ok) {
						return this.stop('record-failed');
					}
					if (next.waitMs > 0) {
						try {
							await this.deps.sleep(next.waitMs, this.deps.signal);
						} catch {
							return this.stop('aborted');
						}
					}
					stage = 'put';
					break;
				}
				case 'stop':
					return this.stop(next.reason);
				case 'fail':
					return this.fail(next.reason === 'failed' && this.putNotFound ? 'not-found' : next.reason);
				case 'unresolved':
					return this.unresolved(next.reason);
				case 'indeterminate': {
					await this.deps.pending.markIndeterminate([...this.live]);
					if (this.recovered) return this.settle([...this.live], 'indeterminate');
					// 6-5: one recovery within the job, in recover mode (same key, no alternate key).
					this.recovered = true;
					this.mode = 'recover';
					attempts = { conflict: 0, digest: 0 };
					stage = 'recover-check';
					break;
				}
				case 'keep-indeterminate': {
					if (this.first().state === 'putting') await this.deps.pending.markIndeterminate([...this.live]);
					return this.settle([...this.live], 'indeterminate');
				}
			}
		}
	}

	private async stop(reason: string): Promise<void> {
		const ids = [...this.live];
		await this.deps.pending.update(ids, { state: 'stopped', reason });
		this.settle(ids, 'stopped', reason);
	}

	private async unresolved(reason: string): Promise<void> {
		const ids = [...this.live];
		await this.deps.pending.update(ids, { state: 'unresolved', reason });
		this.settle(ids, 'unresolved', reason);
	}

	/** failed:* — the record goes only if 7-2 allows it; otherwise it stays as unresolved. */
	private async fail(reason: string): Promise<void> {
		const ids = [...this.live];
		if (this.first().state === 'putting') await this.deps.pending.markPutRejected(ids, reason);
		if ((await this.deps.pending.removeFailed(ids)).ok) return this.settle(ids, 'failed', reason);
		return this.unresolved(reason);
	}

	/**
	 * reused or uploaded: done-unrecorded, then the history, then delivered (7-2). `deliveryKnown`: the object's
	 * delivery form is known to be the items' Content-Type (I14 (f)); recorded with the first write.
	 */
	private async succeed(deliveryKnown: boolean): Promise<void> {
		const ids = [...this.live];
		const key = this.key();
		const items = this.items();
		await this.deps.pending.update(ids, { state: 'done-unrecorded', ...(deliveryKnown ? { deliveryChecked: true as const } : {}) });
		const at = this.deps.now().toISOString();
		const entries: HistoryEntry[] = items.map((i) => ({
			id: this.deps.newId(),
			target: i.target,
			key,
			classification: i.classification,
			sourceSha256: i.sourceSha256,
			sentSha256: i.sentSha256,
			size: i.size,
			format: i.format,
			converter: i.converter,
			at,
		}));
		const saved = await this.deps.settings.mutate(appendHistoryOp(entries));
		if (!saved.ok) return this.settle(ids, 'done-unrecorded', 'history-not-saved', key);
		const delivered = await this.deps.pending.update(ids, { state: 'delivered' });
		this.settle(ids, delivered.ok ? 'delivered' : 'done-unrecorded', delivered.ok ? undefined : 'record-failed', key);
	}
}

/**
 * Sends a new group: records every item first (one write; nothing is sent if it fails), saves I1 for private
 * items, then Heads the candidate key (if the group reuses a key from the history) or the prepared key.
 */
export async function sendGroup(items: readonly NewPendingItem[], bytes: Uint8Array | undefined, deps: UploaderDeps): Promise<ItemResult[]> {
	const ids = items.map((i) => i.id);
	if (!(await deps.pending.add(items)).ok) return ids.map((id) => ({ id, outcome: 'not-recorded' as const }));
	const group = new Group(deps, ids, 'send', bytes, true);
	await group.savePrivate();
	await group.run(items[0]?.phase === 'candidate' ? 'candidate' : 'fresh');
	return group.finish();
}

/**
 * Resumes stored records of one group after the user confirmed it (7-4). The mode comes from the record
 * (6-5); the recorded storage must still be the connection's storage, or nothing is requested (6-5 step 0).
 */
export async function resumeGroup(ids: readonly string[], deps: UploaderDeps): Promise<ItemResult[]> {
	const items = deps.pending.items.filter((i) => ids.includes(i.id));
	const first = items[0];
	if (!first || items.length !== ids.length) return ids.map((id) => ({ id, outcome: 'not-recorded' as const, reason: 'unknown-item' }));
	const plan = resumePlan(first);
	const sameTarget = await deps.settings
		.checkpoint((s) =>
			items.every((i) => {
				const c = s.connections.find((x) => x.id === i.connectionId);
				return c !== undefined && connectionState(s, c) === 'active' && connectionTarget(c) === i.target && c.classification === i.classification;
			}),
		)
		.catch(() => false);
	const group = new Group(deps, ids, plan.mode === 'send' ? 'send' : 'recover', undefined);
	if (!sameTarget || plan.mode === 'unresolved') {
		const reason = sameTarget ? (plan.mode === 'unresolved' ? plan.reason : 'target-mismatch') : 'target-mismatch';
		await deps.pending.update([...ids], { state: 'unresolved', reason });
		return ids.map((id) => ({ id, outcome: 'unresolved' as const, reason }));
	}
	await group.savePrivate();
	await group.run(plan.mode === 'send' ? 'candidate' : 'recover-check');
	return group.finish();
}
