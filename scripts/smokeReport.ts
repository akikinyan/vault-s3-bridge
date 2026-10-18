// Pure helpers of the smoke scripts, kept apart so they can be tested without a bucket.
import { classifyError } from '../src/aws/errors';
import type { PendingItem } from '../src/upload/pending';
import type { DeepReadonly } from '../src/util/deepReadonly';

/** What an unexpected error may print: its classification only. A raw message may hold a URL or other values. */
export function errorDetail(error: unknown): string {
	const c = classifyError(error);
	return `${c.category} ${c.code}${c.httpStatus === undefined ? '' : ` http=${c.httpStatus}`}`;
}

/** Every key under `prefix` that a record names: the uploader may have written any of them. */
export function recordedKeys(items: DeepReadonly<PendingItem[]>, prefix: string): string[] {
	const keys = new Set<string>();
	for (const i of items) for (const key of [i.key, i.preparedKey, i.altKey]) if (key?.startsWith(prefix)) keys.add(key);
	return [...keys];
}
