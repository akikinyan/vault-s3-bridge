// What the upload screens and notices show (design 11-2, 10-4, 7-4), computed without Obsidian.
// Every text is a message key with parameters; the modal and the notices translate them.
import type { MessageKey } from '../i18n';
import type { PluginSettings } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import type { CommandStop, CopyResult, FileOutcome, JobPlan, JobResult, PlannedGroup, ResumeResult, ResumeStop, SkipReason } from './job';
import { identifyingVariables, type KeyVariable } from './key';
import type { PendingItem, PendingState } from './pending';
import type { ItemOutcome } from './uploader';

/** new: sent to a new key; history: the same bytes were uploaded before (Head decides); shared: the group's object; deferred: next run. */
export type RowStatus = 'new' | 'history' | 'shared' | 'deferred';

/** 3-1: the same content was uploaded to public storage before; that public copy stays. */
export type RowWarning = 'public-copy-remains';

export interface FileRow {
	sourcePath: string;
	status: RowStatus;
	key: string;
	sourceSize: number;
	sentSize: number;
	reencoded: boolean;
	markdown: string[];
	warnings: RowWarning[];
}

export interface SkipRow {
	original: string;
	reason: SkipReason;
	detail?: string;
}

export interface PlanView {
	alias: string;
	classification: 'public' | 'private';
	target: string;
	/** Public only: variables in the key template that reveal note or file names in the public URL (5-1). */
	identifying: KeyVariable[];
	rows: FileRow[];
	skipped: SkipRow[];
	/** Bytes this run sends at most (each group once). */
	sendBytes: number;
	/** Something can be sent in this run. */
	sendable: boolean;
}

export function planView(plan: JobPlan, settings: Pick<DeepReadonly<PluginSettings>, 'history'>): PlanView {
	const t = plan.target;
	const publicHashes = new Set(settings.history.filter((h) => h.classification === 'public').flatMap((h) => [h.sourceSha256, h.sentSha256]));
	const rows = (groups: readonly PlannedGroup[], deferred: boolean): FileRow[] =>
		groups.flatMap((g) =>
			g.files.map((f, i) => ({
				sourcePath: f.sourcePath,
				status: deferred ? 'deferred' : i > 0 ? 'shared' : g.phase === 'candidate' ? 'history' : 'new',
				key: g.key,
				sourceSize: f.sourceSize,
				sentSize: g.bytes.length,
				reencoded: g.reencoded,
				markdown: [...new Set(f.occurrences.map((o) => o.markdown))],
				warnings:
					t.classification === 'private' && (publicHashes.has(f.sourceSha256) || publicHashes.has(g.sentSha256)) ? ['public-copy-remains'] : [],
			})),
		);
	return {
		alias: t.alias,
		classification: t.classification,
		target: t.target,
		identifying: t.classification === 'public' ? identifyingVariables(t.keyTemplate) : [],
		rows: [...rows(plan.groups, false), ...rows(plan.deferred, true)],
		skipped: plan.skipped.map((s) => ({ original: s.original, reason: s.reason, ...(s.detail === undefined ? {} : { detail: s.detail }) })),
		sendBytes: plan.groups.reduce((n, g) => n + g.bytes.length, 0),
		sendable: plan.groups.length > 0,
	};
}

export interface Line {
	key: MessageKey;
	params?: Record<string, string>;
}

/** Why the command stopped, or undefined when there is nothing to tell (the user cancelled, or the preview ended). */
export function stopLine(s: CommandStop): Line | undefined {
	switch (s.stop) {
		case 'busy':
			return { key: 'upload.stop.busy' };
		case 'excluded-folder':
			return { key: 'upload.stop.excluded' };
		case 'pending-not-ready':
			return { key: 'upload.stop.pendingNotReady' };
		case 'connection-not-active':
			return { key: 'upload.stop.connectionNotActive' };
		case 'detection':
			switch (s.detection.reason) {
				case 'unparsable':
					return { key: 'upload.stop.unparsable' };
				case 'mismatch':
					return { key: 'upload.stop.mismatch' };
				case 'changed':
					return { key: 'upload.stop.changed' };
			}
			return undefined;
		case 'prepare':
			return { key: s.reason === 'template' ? 'upload.stop.template' : 'upload.stop.publicUrl' };
		case 'no-connection':
		case 'cancelled':
		case 'preview':
			return undefined;
	}
}

const OUTCOME_KEY: Record<Exclude<FileOutcome, 'delivered'>, MessageKey> = {
	'done-unrecorded': 'upload.result.doneUnrecorded',
	stopped: 'upload.result.stopped',
	unresolved: 'upload.result.unresolved',
	indeterminate: 'upload.result.indeterminate',
	failed: 'upload.result.failed',
	excluded: 'upload.result.excluded',
	'not-recorded': 'upload.result.notRecorded',
	'not-started': 'upload.result.notStarted',
};

/** 2-10: the classification of why files did not go through; unknown reasons are not shown. */
const REASON_KEY: Record<string, MessageKey> = {
	'forbidden': 'upload.reason.forbidden',
	'not-found': 'upload.reason.not-found',
	'conflict': 'upload.reason.conflict',
	'digest': 'upload.reason.digest',
	'collision': 'upload.reason.collision',
	'different-object': 'upload.reason.different-object',
	'head': 'upload.reason.head',
	'failed': 'upload.reason.failed',
	'permission': 'upload.reason.permission',
	'candidate-unverified': 'upload.reason.candidate-unverified',
	'credentials': 'upload.reason.credentials',
	'changed': 'upload.reason.changed',
	'private-recorded': 'upload.reason.private-recorded',
	'private-not-saved': 'upload.reason.private-not-saved',
	'connection-changed': 'upload.reason.connection-changed',
	'read-only': 'upload.reason.read-only',
	'record-failed': 'upload.reason.record-failed',
	'cannot-rebuild': 'upload.reason.cannot-rebuild',
	'markdown-check': 'upload.reason.markdown-check',
};

const ABORT_KEY: Record<NonNullable<JobResult['aborted']>, MessageKey> = {
	stop: 'upload.result.abortedStop',
	'connection-changed': 'upload.result.abortedConnection',
	'auth-changed': 'upload.result.abortedAuth',
};

const FALLBACK_KEY: Record<'closed' | 'deleted' | 'changed', MessageKey> = {
	closed: 'upload.result.fallbackClosed',
	deleted: 'upload.result.fallbackDeleted',
	changed: 'upload.result.fallbackChanged',
};

/** The result notice: what was linked, what else happened (by outcome), and how the links were made. */
export function resultLines(r: JobResult): { lines: Line[]; warn: boolean } {
	const lines: Line[] = [];
	if (r.aborted) lines.push({ key: ABORT_KEY[r.aborted] });
	const linked = r.files.filter((f) => f.linked).length;
	// A copy leaves the note unchanged, so it is not reported as linked.
	if (linked > 0) lines.push({ key: r.link.kind === 'copied' ? 'upload.result.uploadedForCopy' : 'upload.result.linked', params: { n: String(linked) } });
	// Delivered without a link: the object exists, the record stays (copy from the settings).
	const waiting = r.files.filter((f) => f.outcome === 'delivered' && !f.linked).length;
	if (waiting > 0) lines.push({ key: 'upload.result.deliveredNotLinked', params: { n: String(waiting) } });
	const counts = new Map<FileOutcome, number>();
	for (const f of r.files) if (f.outcome !== 'delivered') counts.set(f.outcome, (counts.get(f.outcome) ?? 0) + 1);
	for (const [outcome, n] of counts) {
		lines.push({ key: OUTCOME_KEY[outcome as Exclude<FileOutcome, 'delivered'>], params: { n: String(n) } });
		const reasons = new Map<MessageKey, number>();
		for (const f of r.files) {
			const key = f.outcome === outcome && f.reason !== undefined ? REASON_KEY[f.reason] : undefined;
			if (key) reasons.set(key, (reasons.get(key) ?? 0) + 1);
		}
		for (const [key, m] of reasons) lines.push({ key, params: { n: String(m) } });
	}

	const link = r.link;
	if (link.kind === 'applied' && link.apply.applied && !link.apply.verified) lines.push({ key: 'upload.result.unverified' });
	if (link.kind === 'copied') {
		if (link.fallback && !link.fallback.applied) lines.push({ key: FALLBACK_KEY[link.fallback.reason] });
		lines.push({ key: link.ok ? 'upload.result.copied' : 'upload.result.copyFailed' });
	}
	const left = r.files.some((f) => f.outcome !== 'failed' && f.outcome !== 'excluded' && f.outcome !== 'not-started' && f.outcome !== 'not-recorded' && !f.linked);
	if (left) lines.push({ key: 'upload.result.recordsLeft' });
	if (lines.length === 0) lines.push({ key: 'upload.result.nothing' });
	const warn = r.aborted !== undefined || left || (link.kind === 'copied' && !link.ok) || r.files.some((f) => !f.linked);
	return { lines, warn };
}

/** 7-4: told when a command runs on a device that still has records; never resumed automatically. */
export function pendingLine(items: DeepReadonly<PendingItem[]>): Line | undefined {
	return items.length > 0 ? { key: 'upload.pendingExists', params: { n: String(items.length) } } : undefined;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** D10: the label comes from the state, never from `uncertain`. */
export const STATE_KEY: Record<PendingState, MessageKey> = {
	recorded: 'pending.state.recorded',
	putting: 'pending.state.unknown',
	indeterminate: 'pending.state.unknown',
	unresolved: 'pending.state.unresolved',
	'done-unrecorded': 'pending.state.doneUnrecorded',
	delivered: 'pending.state.delivered',
	stopped: 'pending.state.stopped',
};

export function resumeLines(r: ResumeStop | { done: ResumeResult[]; mismatched: number }): Line[] {
	if ('stop' in r) {
		switch (r.stop) {
			case 'busy':
				return [{ key: 'upload.stop.busy' }];
			case 'pending-not-ready':
				return [{ key: 'upload.stop.pendingNotReady' }];
			case 'nothing':
				return [{ key: r.mismatched > 0 ? 'pending.resume.mismatched' : 'pending.resume.nothing', params: { n: String(r.mismatched) } }];
			case 'cancelled':
				return [];
		}
	}
	const lines: Line[] = [];
	const counts = new Map<Exclude<ItemOutcome, 'delivered'>, number>();
	let delivered = 0;
	for (const d of r.done) {
		if (d.aborted) lines.push({ key: ABORT_KEY[d.aborted] });
		for (const x of d.results) {
			if (x.outcome === 'delivered') delivered++;
			else counts.set(x.outcome, (counts.get(x.outcome) ?? 0) + 1);
		}
	}
	if (delivered > 0) lines.push({ key: 'pending.resume.delivered', params: { n: String(delivered) } });
	for (const [outcome, n] of counts) lines.push({ key: OUTCOME_KEY[outcome], params: { n: String(n) } });
	if (r.mismatched > 0) lines.push({ key: 'pending.resume.mismatched', params: { n: String(r.mismatched) } });
	return lines;
}

const COPY_SKIP_KEY: Record<Extract<CopyResult, { copied: number }>['skipped'][number]['reason'], MessageKey> = {
	'target-mismatch': 'pending.copy.targetMismatch',
	'markdown-check': 'pending.copy.markdownCheck',
	'private-recorded': 'pending.copy.privateRecorded',
};

export function copyLines(r: CopyResult): Line[] {
	if ('stop' in r) return [{ key: r.stop === 'busy' ? 'upload.stop.busy' : r.stop === 'nothing' ? 'pending.copy.nothing' : 'upload.stop.pendingNotReady' }];
	const lines: Line[] = [];
	if (r.copied > 0) lines.push({ key: 'pending.copy.copied', params: { n: String(r.copied) } });
	if (!r.ok) lines.push({ key: 'pending.copy.failed' });
	const by = new Map<MessageKey, number>();
	for (const s of r.skipped) by.set(COPY_SKIP_KEY[s.reason], (by.get(COPY_SKIP_KEY[s.reason]) ?? 0) + 1);
	for (const [key, n] of by) lines.push({ key, params: { n: String(n) } });
	return lines;
}

/** 11-2: how much the bytes sent differ from the original, e.g. "-30%" or "+12%". */
export function sizeChange(from: number, to: number): string {
	if (from === 0) return to === 0 ? '±0%' : '+∞';
	const pct = Math.round(((to - from) / from) * 100);
	return pct === 0 ? '±0%' : `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`;
}
