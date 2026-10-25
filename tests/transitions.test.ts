import { describe, expect, it } from 'vitest';
import { afterHead, afterPut, conflictWaitMs, type HeadResult, type HeadStage, type Next, type PutResult, resumePlan } from '../src/upload/transitions';

// Rows written from the tables of design 6-3 / 6-6, not from the implementation.
const HEAD_ROWS: [HeadStage, HeadResult, Next][] = [
	// checking, candidate key (6-0 step 5)
	['candidate', 'match', { do: 'reuse' }],
	['candidate', 'mismatch', { do: 'drop-candidate' }],
	['candidate', 'absent', { do: 'drop-candidate' }],
	['candidate', 'head-forbidden', { do: 'stop', reason: 'candidate-unverified' }],
	['candidate', 'indeterminate', { do: 'stop', reason: 'candidate-unverified' }],
	['candidate', 'failed', { do: 'stop', reason: 'candidate-unverified' }],
	['candidate', 'aborted', { do: 'stop', reason: 'aborted' }],
	// checking, new or alternate key
	['fresh', 'match', { do: 'reuse' }],
	['fresh', 'mismatch', { do: 'collision' }],
	['fresh', 'absent', { do: 'put' }],
	['fresh', 'head-forbidden', { do: 'put' }],
	['fresh', 'indeterminate', { do: 'fail', reason: 'head' }],
	['fresh', 'failed', { do: 'fail', reason: 'head' }],
	['fresh', 'aborted', { do: 'stop', reason: 'aborted' }],
	// verifying (after 412)
	['verify', 'match', { do: 'reuse' }],
	['verify', 'mismatch', { do: 'collision' }],
	['verify', 'absent', { do: 'unresolved', reason: 'absent-after-412' }],
	['verify', 'head-forbidden', { do: 'stop', reason: 'permission' }],
	['verify', 'indeterminate', { do: 'unresolved', reason: 'verify-indeterminate' }],
	['verify', 'failed', { do: 'unresolved', reason: 'verify-failed' }],
	['verify', 'aborted', { do: 'stop', reason: 'aborted' }],
	// recover-check (6-5 step 1): never an alternate key
	['recover-check', 'match', { do: 'reuse' }],
	['recover-check', 'mismatch', { do: 'unresolved', reason: 'different-object' }],
	['recover-check', 'absent', { do: 'resend-check' }],
	['recover-check', 'head-forbidden', { do: 'resend-check' }],
	['recover-check', 'indeterminate', { do: 'keep-indeterminate' }],
	['recover-check', 'failed', { do: 'unresolved', reason: 'head-failed' }],
	['recover-check', 'aborted', { do: 'stop', reason: 'aborted' }],
	// recover-verify (after 412 in recover): only a match is reuse; aborts and unknowns stay resumable
	['recover-verify', 'match', { do: 'reuse' }],
	['recover-verify', 'mismatch', { do: 'unresolved', reason: 'different-object' }],
	['recover-verify', 'absent', { do: 'unresolved', reason: 'absent-after-412' }],
	['recover-verify', 'head-forbidden', { do: 'unresolved', reason: 'verify-forbidden' }],
	['recover-verify', 'indeterminate', { do: 'keep-indeterminate' }],
	['recover-verify', 'failed', { do: 'unresolved', reason: 'verify-failed' }],
	['recover-verify', 'aborted', { do: 'stop', reason: 'aborted' }],
];

describe('afterHead (6-3 Head table)', () => {
	it.each(HEAD_ROWS)('%s / %s', (stage, result, next) => {
		expect(afterHead(stage, result)).toEqual(next);
	});

	it('covers every stage and result', () => {
		expect(HEAD_ROWS).toHaveLength(5 * 7);
	});

	it('never moves to an alternate key or a new Put from recover mode', () => {
		for (const [s, r] of HEAD_ROWS.filter(([s]) => s === 'recover-check' || s === 'recover-verify')) {
			expect(['collision', 'put', 'drop-candidate']).not.toContain(afterHead(s, r).do);
		}
	});
});

const one = { conflict: 1, digest: 1 };
const half = () => 0.5;
const PUT_ROWS: ['send' | 'recover', PutResult, { conflict: number; digest: number }, Next][] = [
	['send', 'ok', one, { do: 'uploaded' }],
	['send', 'precondition', one, { do: 'verify' }],
	['send', 'conflict', { conflict: 1, digest: 0 }, { do: 'retry', waitMs: 500 }],
	['send', 'conflict', { conflict: 2, digest: 0 }, { do: 'retry', waitMs: 1000 }],
	['send', 'conflict', { conflict: 3, digest: 0 }, { do: 'fail', reason: 'conflict' }],
	['send', 'digest', { conflict: 0, digest: 1 }, { do: 'retry', waitMs: 0 }],
	['send', 'digest', { conflict: 0, digest: 2 }, { do: 'fail', reason: 'digest' }],
	['send', 'forbidden', one, { do: 'fail', reason: 'forbidden' }],
	['send', 'indeterminate', one, { do: 'indeterminate' }],
	['send', 'failed', one, { do: 'fail', reason: 'failed' }],
	['recover', 'ok', one, { do: 'uploaded' }],
	['recover', 'precondition', one, { do: 'verify' }],
	['recover', 'conflict', { conflict: 2, digest: 0 }, { do: 'retry', waitMs: 1000 }],
	['recover', 'conflict', { conflict: 3, digest: 0 }, { do: 'unresolved', reason: 'conflict' }],
	['recover', 'digest', { conflict: 0, digest: 1 }, { do: 'retry', waitMs: 0 }],
	['recover', 'digest', { conflict: 0, digest: 2 }, { do: 'unresolved', reason: 'digest' }],
	['recover', 'forbidden', one, { do: 'unresolved', reason: 'forbidden' }],
	['recover', 'indeterminate', one, { do: 'keep-indeterminate' }],
	['recover', 'failed', one, { do: 'unresolved', reason: 'put-failed' }],
];

describe('afterPut (6-3 Put table, 6-4)', () => {
	it.each(PUT_ROWS)('%s / %s %o', (mode, result, attempts, next) => {
		expect(afterPut(mode, result, attempts, half)).toEqual(next);
	});

	it('recover mode never ends in failed:*', () => {
		for (const [mode, r, a] of PUT_ROWS.filter(([m]) => m === 'recover')) expect(afterPut(mode, r, a, half).do).not.toBe('fail');
	});

	it('jitters the 409 wait by ±20 %', () => {
		expect(conflictWaitMs(1, () => 0)).toBe(400);
		expect(conflictWaitMs(1, () => 1)).toBe(600);
		expect(conflictWaitMs(2, () => 0)).toBe(800);
		expect(conflictWaitMs(2, () => 1)).toBe(1200);
	});
});

describe('resumePlan (6-5)', () => {
	it('decides by phase and putSent only', () => {
		expect(resumePlan({ phase: 'candidate', putSent: false })).toEqual({ mode: 'send', from: 'candidate' });
		expect(resumePlan({ phase: 'candidate', putSent: true })).toEqual({ mode: 'unresolved', reason: 'candidate-put' });
		expect(resumePlan({ phase: 'prepared', putSent: false })).toEqual({ mode: 'recover' });
		expect(resumePlan({ phase: 'prepared', putSent: true })).toEqual({ mode: 'recover' });
		expect(resumePlan({ phase: 'alt', putSent: true })).toEqual({ mode: 'recover' });
	});
});

describe('afterHead: a delivery mismatch takes the content mismatch step (design 3-4)', () => {
	it.each(['candidate', 'fresh', 'verify'] as const)('%s', (stage) => {
		expect(afterHead(stage, 'delivery-mismatch')).toEqual(afterHead(stage, 'mismatch'));
	});
	it.each(['recover-check', 'recover-verify'] as const)('%s: unresolved, never another key', (stage) => {
		expect(afterHead(stage, 'delivery-mismatch')).toEqual({ do: 'unresolved', reason: 'different-delivery' });
	});
});
