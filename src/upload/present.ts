// What the upload screens and notices show (design 11-2, 10-4, 7-4), computed without Obsidian.
// Every text is a message key with parameters; the modal and the notices translate them.
import type { MessageKey } from '../i18n';
import type { PluginSettings } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import type { CommandStop, FileOutcome, JobPlan, JobResult, PlannedGroup, SkipReason } from './job';
import { identifyingVariables, type KeyVariable } from './key';
import type { PendingItem } from './pending';

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
	if (linked > 0) lines.push({ key: 'upload.result.linked', params: { n: String(linked) } });
	// Delivered without a link: the object exists, the record stays (copy from the settings).
	const waiting = r.files.filter((f) => f.outcome === 'delivered' && !f.linked).length;
	if (waiting > 0) lines.push({ key: 'upload.result.deliveredNotLinked', params: { n: String(waiting) } });
	const counts = new Map<FileOutcome, number>();
	for (const f of r.files) if (f.outcome !== 'delivered') counts.set(f.outcome, (counts.get(f.outcome) ?? 0) + 1);
	for (const [outcome, n] of counts) lines.push({ key: OUTCOME_KEY[outcome as Exclude<FileOutcome, 'delivered'>], params: { n: String(n) } });

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
