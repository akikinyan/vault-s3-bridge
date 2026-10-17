import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/settings/types';
import type { FileResult, JobPlan, JobResult, PlannedGroup } from '../src/upload/job';
import { copyLines, formatBytes, sizeChange, pendingLine, planView, resultLines, resumeLines, STATE_KEY, stopLine } from '../src/upload/present';
import { newItem } from './fixtures/pendingItems';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const S = 's'.repeat(64).replace(/s/g, 'c');

function group(over: Partial<PlannedGroup> & { files: PlannedGroup['files'] }): PlannedGroup {
	return {
		groupId: 'g',
		key: 'k/a.png',
		preparedKey: 'k/a.png',
		phase: 'prepared',
		sentSha256: S,
		format: 'png',
		converter: 'c1;orig',
		bytes: new Uint8Array(300),
		reencoded: false,
		...over,
	};
}

const file = (path: string, sha: string, md = [`![a](s3://work/k/a.png)`]) => ({
	itemId: path,
	sourcePath: path,
	basename: 'a',
	sourceSha256: sha,
	sourceSize: 1000,
	occurrences: md.map((m, i) => ({ offset: i, original: '![[a.png]]', inTable: false, syntax: { kind: 'wiki' as const, path: 'a.png' }, markdown: m })),
});

function plan(over: Partial<JobPlan> = {}, classification: 'public' | 'private' = 'private', keyTemplate = 'k/{filename}.{ext}'): JobPlan {
	return {
		jobId: 'j',
		notePath: 'n.md',
		snapshot: '',
		target: { connectionId: 'c1', alias: 'work', classification, target: 'aws:example', keyTemplate, ...(classification === 'public' ? { publicBaseUrl: 'https://cdn.example.com' } : {}) },
		groups: [],
		deferred: [],
		skipped: [],
		...over,
	};
}

const hist = (classification: 'public' | 'private', sourceSha256: string, sentSha256 = S): HistoryEntry => ({
	id: 'h',
	target: 'aws:other',
	key: 'x',
	classification,
	sourceSha256,
	sentSha256,
	size: 1,
	format: 'png',
	converter: 'c1;orig',
	at: '2026-10-01T00:00:00Z',
});

describe('planView (11-2)', () => {
	it('shows each file with its status, key, sizes and distinct Markdown', () => {
		const p = plan({
			groups: [group({ phase: 'candidate', files: [file('img/a.png', A, ['![a](s3://work/k/a.png)', '![a](s3://work/k/a.png)']), file('img/a2.png', A)] })],
			deferred: [group({ groupId: 'g2', key: 'k/b.png', bytes: new Uint8Array(50), files: [file('img/b.png', B)] })],
			skipped: [{ offset: 9, original: '![[x.svg]]', reason: 'unsupported' }],
		});
		const v = planView(p, { history: [] });
		expect(v.rows.map((r) => [r.sourcePath, r.status, r.key, r.sourceSize, r.sentSize])).toEqual([
			['img/a.png', 'history', 'k/a.png', 1000, 300],
			['img/a2.png', 'shared', 'k/a.png', 1000, 300],
			['img/b.png', 'deferred', 'k/b.png', 1000, 50],
		]);
		expect(v.rows[0]!.markdown).toEqual(['![a](s3://work/k/a.png)']);
		expect(v.skipped).toEqual([{ original: '![[x.svg]]', reason: 'unsupported' }]);
		// Deferred groups are not sent in this run.
		expect(v.sendBytes).toBe(300);
		expect(v.sendable).toBe(true);
	});

	it('a prepared group is new; nothing in groups is not sendable', () => {
		expect(planView(plan({ groups: [group({ files: [file('img/a.png', A)] })] }), { history: [] }).rows[0]!.status).toBe('new');
		const v = planView(plan({ deferred: [group({ files: [file('img/a.png', A)] })] }), { history: [] });
		expect(v.sendable).toBe(false);
		expect(v.sendBytes).toBe(0);
	});

	it('warns on private uploads of content sent to public storage before (source or sent hash)', () => {
		const p = plan({ groups: [group({ files: [file('img/a.png', A)] }), group({ groupId: 'g2', sentSha256: B, files: [file('img/b.png', 'd'.repeat(64))] })] });
		expect(planView(p, { history: [hist('public', A, 'e'.repeat(64))] }).rows.map((r) => r.warnings)).toEqual([['public-copy-remains'], []]);
		expect(planView(p, { history: [hist('public', 'f'.repeat(64), B)] }).rows.map((r) => r.warnings)).toEqual([[], ['public-copy-remains']]);
		// A private history entry is not a public copy.
		expect(planView(p, { history: [hist('private', A)] }).rows[0]!.warnings).toEqual([]);
		// Uploading to public: the warning is about private uploads only.
		const pub = plan({ groups: [group({ files: [file('img/a.png', A)] })] }, 'public', 'p/{hash}.{ext}');
		expect(planView(pub, { history: [hist('public', A)] }).rows[0]!.warnings).toEqual([]);
	});

	it('lists name-revealing variables of a public key template only', () => {
		expect(planView(plan({}, 'public', 'p/{notename}/{filename}.{ext}'), { history: [] }).identifying).toEqual(['notename', 'filename']);
		expect(planView(plan({}, 'public', 'p/{hash}.{ext}'), { history: [] }).identifying).toEqual([]);
		expect(planView(plan({}, 'private', 'k/{filename}.{ext}'), { history: [] }).identifying).toEqual([]);
	});
});

describe('stopLine', () => {
	it('explains every stop except the silent ones', () => {
		expect(stopLine({ stop: 'busy' })?.key).toBe('upload.stop.busy');
		expect(stopLine({ stop: 'excluded-folder' })?.key).toBe('upload.stop.excluded');
		expect(stopLine({ stop: 'pending-not-ready' })?.key).toBe('upload.stop.pendingNotReady');
		expect(stopLine({ stop: 'connection-not-active' })?.key).toBe('upload.stop.connectionNotActive');
		expect(stopLine({ stop: 'detection', detection: { ok: false, reason: 'changed' } })?.key).toBe('upload.stop.changed');
		expect(stopLine({ stop: 'detection', detection: { ok: false, reason: 'unparsable', problem: 'lone-cr', offset: 0 } })?.key).toBe('upload.stop.unparsable');
		expect(stopLine({ stop: 'detection', detection: { ok: false, reason: 'mismatch', mismatch: { kind: 'count', own: 1, cache: 0 } as never } })?.key).toBe('upload.stop.mismatch');
		expect(stopLine({ stop: 'prepare', reason: 'template' })?.key).toBe('upload.stop.template');
		expect(stopLine({ stop: 'prepare', reason: 'public-url' })?.key).toBe('upload.stop.publicUrl');
		expect(stopLine({ stop: 'no-connection' })).toBeUndefined();
		expect(stopLine({ stop: 'cancelled', plan: plan() })).toBeUndefined();
		expect(stopLine({ stop: 'preview', plan: plan() })).toBeUndefined();
	});
});

const fr = (outcome: FileResult['outcome'], linked = false): FileResult => ({ itemId: 'i', sourcePath: 'p', outcome, linked });
const keys = (r: JobResult) => resultLines(r).lines.map((l) => (l.params?.n ? `${l.key}:${l.params.n}` : l.key));

describe('resultLines', () => {
	it('all linked by replacing: one line, no warning', () => {
		const r: JobResult = { files: [fr('delivered', true), fr('delivered', true)], link: { kind: 'applied', apply: { applied: true, via: 'editor', verified: true } } };
		expect(keys(r)).toEqual(['upload.result.linked:2']);
		expect(resultLines(r).warn).toBe(false);
	});

	it('copied: says the Markdown is based on the note as prepared', () => {
		const r: JobResult = { files: [fr('delivered', true)], link: { kind: 'copied', ok: true } };
		expect(keys(r)).toEqual(['upload.result.linked:1', 'upload.result.copied']);
		expect(resultLines(r).warn).toBe(false);
	});

	it('replacing fell back to copying: the reason comes first', () => {
		const r: JobResult = { files: [fr('delivered', true)], link: { kind: 'copied', ok: true, fallback: { applied: false, reason: 'changed' } } };
		expect(keys(r)).toEqual(['upload.result.linked:1', 'upload.result.fallbackChanged', 'upload.result.copied']);
	});

	it('copy failed: delivered items stay recorded and the user is told where to copy them', () => {
		const r: JobResult = { files: [fr('delivered')], link: { kind: 'copied', ok: false } };
		expect(keys(r)).toEqual(['upload.result.deliveredNotLinked:1', 'upload.result.copyFailed', 'upload.result.recordsLeft']);
		expect(resultLines(r).warn).toBe(true);
	});

	it('an unverified replacement is reported', () => {
		const r: JobResult = { files: [fr('delivered', true)], link: { kind: 'applied', apply: { applied: true, via: 'file', verified: false } } };
		expect(keys(r)).toContain('upload.result.unverified');
	});

	it('counts other outcomes and the abort cause; records left only for outcomes that keep a record', () => {
		const r: JobResult = {
			files: [fr('indeterminate'), fr('indeterminate'), fr('stopped'), fr('not-started')],
			link: { kind: 'none' },
			aborted: 'auth-changed',
		};
		expect(keys(r)).toEqual(['upload.result.abortedAuth', 'upload.result.indeterminate:2', 'upload.result.stopped:1', 'upload.result.notStarted:1', 'upload.result.recordsLeft']);
		const gone: JobResult = { files: [fr('failed'), fr('excluded')], link: { kind: 'none' } };
		expect(keys(gone)).toEqual(['upload.result.failed:1', 'upload.result.excluded:1']);
		expect(resultLines(gone).warn).toBe(true);
	});

	it('no files at all', () => {
		expect(keys({ files: [], link: { kind: 'none' } })).toEqual(['upload.result.nothing']);
	});
});

describe('pendingLine (7-4)', () => {
	it('tells about records of this device, and nothing when there are none', () => {
		expect(pendingLine([])).toBeUndefined();
		expect(pendingLine([{ ...newItem('a'), state: 'delivered' } as never])).toEqual({ key: 'upload.pendingExists', params: { n: '1' } });
	});
});

it('formatBytes', () => {
	expect([formatBytes(10), formatBytes(2048), formatBytes(3 * 1024 * 1024)]).toEqual(['10 B', '2.0 KB', '3.0 MB']);
});

const ks = (lines: { key: string; params?: Record<string, string> }[]) => lines.map((l) => (l.params?.n ? `${l.key}:${l.params.n}` : l.key));

describe('records (7-4)', () => {
	it('labels come from the state; putting and indeterminate are both "result unknown" (D10)', () => {
		expect(STATE_KEY.putting).toBe('pending.state.unknown');
		expect(STATE_KEY.indeterminate).toBe('pending.state.unknown');
		expect(STATE_KEY.delivered).toBe('pending.state.delivered');
		expect(STATE_KEY.recorded).toBe('pending.state.recorded');
	});

	it('resumeLines', () => {
		expect(ks(resumeLines({ stop: 'busy' }))).toEqual(['upload.stop.busy']);
		expect(ks(resumeLines({ stop: 'cancelled' }))).toEqual([]);
		expect(ks(resumeLines({ stop: 'nothing', mismatched: 0 }))).toEqual(['pending.resume.nothing:0']);
		expect(ks(resumeLines({ stop: 'nothing', mismatched: 2 }))).toEqual(['pending.resume.mismatched:2']);
		const done = {
			done: [
				{ connectionId: 'c1', results: [{ id: 'a', outcome: 'delivered' as const }, { id: 'b', outcome: 'unresolved' as const }] },
				{ connectionId: 'c2', results: [{ id: 'c', outcome: 'delivered' as const }], aborted: 'stop' as const },
			],
			mismatched: 1,
		};
		expect(ks(resumeLines(done))).toEqual(['upload.result.abortedStop', 'pending.resume.delivered:2', 'upload.result.unresolved:1', 'pending.resume.mismatched:1']);
	});

	it('copyLines', () => {
		expect(ks(copyLines({ stop: 'nothing' }))).toEqual(['pending.copy.nothing']);
		expect(ks(copyLines({ stop: 'busy' }))).toEqual(['upload.stop.busy']);
		expect(ks(copyLines({ stop: 'pending-not-ready' }))).toEqual(['upload.stop.pendingNotReady']);
		expect(
			ks(
				copyLines({
					copied: 2,
					ok: true,
					skipped: [
						{ id: 'x', reason: 'private-recorded' },
						{ id: 'y', reason: 'private-recorded' },
						{ id: 'z', reason: 'target-mismatch' },
					],
				}),
			),
		).toEqual(['pending.copy.copied:2', 'pending.copy.privateRecorded:2', 'pending.copy.targetMismatch:1']);
		expect(ks(copyLines({ copied: 0, ok: false, skipped: [] }))).toEqual(['pending.copy.failed']);
	});
});

it('sizeChange', () => {
	expect([sizeChange(1000, 700), sizeChange(1000, 1120), sizeChange(1000, 1000), sizeChange(1000, 1004), sizeChange(0, 0), sizeChange(0, 5)]).toEqual(['−30%', '+12%', '±0%', '±0%', '±0%', '+∞']);
});
