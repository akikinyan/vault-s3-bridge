// Pure transition rules of one send group (design 6-3, 6-4, 6-5, 6-6). No I/O: the uploader performs the step.
import type { KeyPhase } from './pending';
import type { HeadContent, HeadOutcome, PutOutcome } from './s3';

export type Mode = 'send' | 'recover';

/** Which Head this is. `fresh` is a new or alternate key in send mode. */
export type HeadStage = 'candidate' | 'fresh' | 'verify' | 'recover-check' | 'recover-verify';
export type HeadResult = HeadContent | HeadOutcome;
export type PutResult = 'ok' | PutOutcome;

export type StopReason = 'aborted' | 'candidate-unverified' | 'permission';

export type Next =
	| { do: 'reuse' }
	/** The candidate key cannot be used (6-0 step 5): switch every item to the prepared key, then Head it. */
	| { do: 'drop-candidate' }
	| { do: 'put' }
	/** Different content at the key: the alternate key if not used yet, otherwise failed:collision (send only). */
	| { do: 'collision' }
	/** Recover after a Head that found nothing (or was forbidden): re-send only if the bytes can be rebuilt (6-5 step 2). */
	| { do: 'resend-check' }
	| { do: 'verify' }
	| { do: 'retry'; waitMs: number }
	| { do: 'uploaded' }
	| { do: 'stop'; reason: StopReason }
	/** Terminal failure in send mode; the record is removed only when 7-2 allows it. */
	| { do: 'fail'; reason: 'head' | 'conflict' | 'digest' | 'forbidden' | 'failed' | 'collision' }
	| { do: 'unresolved'; reason: string }
	/** Send mode: the Put's outcome is unknown; record it and recover once (6-5). */
	| { do: 'indeterminate' }
	/** Recover mode: still unknown; keep the record for a later resume. */
	| { do: 'keep-indeterminate' };

/** Total attempts per key (the first included) for 409, and for digest errors (6-3, 6-4). */
export const MAX_CONFLICT_ATTEMPTS = 3;
export const MAX_DIGEST_ATTEMPTS = 2;
const CONFLICT_WAIT_MS = [500, 1000];

/** Wait before the n-th retry after a 409 (n = 1, 2), with ±20 % jitter. */
export function conflictWaitMs(retry: number, random: () => number): number {
	const base = CONFLICT_WAIT_MS[Math.min(retry, CONFLICT_WAIT_MS.length) - 1] ?? CONFLICT_WAIT_MS[0]!;
	return Math.round(base * (0.8 + 0.4 * random()));
}

const HEAD: Record<HeadStage, Record<HeadResult, Next>> = {
	candidate: {
		match: { do: 'reuse' },
		mismatch: { do: 'drop-candidate' },
		absent: { do: 'drop-candidate' },
		'head-forbidden': { do: 'stop', reason: 'candidate-unverified' },
		indeterminate: { do: 'stop', reason: 'candidate-unverified' },
		failed: { do: 'stop', reason: 'candidate-unverified' },
		aborted: { do: 'stop', reason: 'aborted' },
	},
	fresh: {
		match: { do: 'reuse' },
		mismatch: { do: 'collision' },
		absent: { do: 'put' },
		'head-forbidden': { do: 'put' },
		indeterminate: { do: 'fail', reason: 'head' },
		failed: { do: 'fail', reason: 'head' },
		aborted: { do: 'stop', reason: 'aborted' },
	},
	verify: {
		match: { do: 'reuse' },
		mismatch: { do: 'collision' },
		absent: { do: 'unresolved', reason: 'absent-after-412' },
		'head-forbidden': { do: 'stop', reason: 'permission' },
		indeterminate: { do: 'unresolved', reason: 'verify-indeterminate' },
		failed: { do: 'unresolved', reason: 'verify-failed' },
		aborted: { do: 'stop', reason: 'aborted' },
	},
	'recover-check': {
		match: { do: 'reuse' },
		mismatch: { do: 'unresolved', reason: 'different-object' },
		absent: { do: 'resend-check' },
		'head-forbidden': { do: 'resend-check' },
		indeterminate: { do: 'keep-indeterminate' },
		failed: { do: 'unresolved', reason: 'head-failed' },
		aborted: { do: 'stop', reason: 'aborted' },
	},
	'recover-verify': {
		match: { do: 'reuse' },
		mismatch: { do: 'unresolved', reason: 'different-object' },
		absent: { do: 'unresolved', reason: 'absent-after-412' },
		'head-forbidden': { do: 'unresolved', reason: 'verify-forbidden' },
		indeterminate: { do: 'keep-indeterminate' },
		failed: { do: 'unresolved', reason: 'verify-failed' },
		aborted: { do: 'stop', reason: 'aborted' },
	},
};

export function afterHead(stage: HeadStage, result: HeadResult): Next {
	return HEAD[stage][result];
}

/**
 * @param attempts Puts sent to the current key so far, this one included, counted separately for 409 and digest.
 */
export function afterPut(mode: Mode, result: PutResult, attempts: { conflict: number; digest: number }, random: () => number): Next {
	const send = mode === 'send';
	switch (result) {
		case 'ok':
			return { do: 'uploaded' };
		case 'precondition':
			return { do: 'verify' };
		case 'conflict':
			if (attempts.conflict < MAX_CONFLICT_ATTEMPTS) return { do: 'retry', waitMs: conflictWaitMs(attempts.conflict, random) };
			return send ? { do: 'fail', reason: 'conflict' } : { do: 'unresolved', reason: 'conflict' };
		case 'digest':
			if (attempts.digest < MAX_DIGEST_ATTEMPTS) return { do: 'retry', waitMs: 0 };
			return send ? { do: 'fail', reason: 'digest' } : { do: 'unresolved', reason: 'digest' };
		case 'forbidden':
			return send ? { do: 'fail', reason: 'forbidden' } : { do: 'unresolved', reason: 'forbidden' };
		case 'indeterminate':
			return send ? { do: 'indeterminate' } : { do: 'keep-indeterminate' };
		case 'failed':
			return send ? { do: 'fail', reason: 'failed' } : { do: 'unresolved', reason: 'put-failed' };
	}
}

export type ResumePlan = { mode: 'send'; from: 'candidate' } | { mode: 'recover' } | { mode: 'unresolved'; reason: string };

/** How a stored record is resumed: decided by the recorded phase and putSent only, never by a stop reason (6-5). */
export function resumePlan(item: { phase: KeyPhase; putSent: boolean }): ResumePlan {
	if (item.phase === 'candidate') return item.putSent ? { mode: 'unresolved', reason: 'candidate-put' } : { mode: 'send', from: 'candidate' };
	return { mode: 'recover' };
}
