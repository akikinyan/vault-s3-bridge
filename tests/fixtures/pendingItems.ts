import type { NewPendingItem, PendingItem } from '../../src/upload/pending';

export const OWN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export function newItem(id: string, over: Partial<NewPendingItem> = {}): NewPendingItem {
	return {
		id,
		jobId: 'job-1',
		groupId: 'g-1',
		connectionId: 'c1',
		target: 'aws:<bucket>',
		classification: 'private',
		notePath: 'notes/n.md',
		sourcePath: `assets/${id}.png`,
		sourceSha256: 'a'.repeat(64),
		sentSha256: 'b'.repeat(64),
		size: 10,
		format: 'png',
		converter: 'c1;orig',
		key: `k/${id}.png`,
		preparedKey: `k/${id}.png`,
		phase: 'prepared',
		occurrences: [{ original: `![[${id}.png]]`, alt: id, inTable: false }],
		apply: 'replace',
		...over,
	};
}

/** A stored item as it would appear in a record file. */
export function storedItem(id: string, over: Partial<PendingItem> = {}): PendingItem {
	return {
		...newItem(id),
		state: 'recorded',
		uncertain: false,
		putSent: false,
		createdAt: '2026-10-17T00:00:00.000Z',
		updatedAt: '2026-10-17T00:00:00.000Z',
		...over,
	};
}

export const fileText = (deviceId: string, items: unknown[]) => JSON.stringify({ version: 1, deviceId, items });
