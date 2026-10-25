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
		contentType: 'image/png',
		converter: 'c1;orig',
		key: `k/${id}.png`,
		preparedKey: `k/${id}.png`,
		phase: 'prepared',
		occurrences: [{ original: `![[${id}.png]]`, kind: 'embed', alt: id, inTable: false }],
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
		deliveryChecked: false,
		createdAt: '2026-10-17T00:00:00.000Z',
		updatedAt: '2026-10-17T00:00:00.000Z',
		...over,
	};
}

export const fileText = (deviceId: string, items: unknown[], version: number = 1) => JSON.stringify({ version, deviceId, items });

/** An item exactly as Phase 3 (record version 1) wrote it: no Content-Type, no delivery check, no occurrence kind. */
export function v1Item(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
	const { contentType: _c, deliveryChecked: _d, occurrences, ...rest } = storedItem(id);
	return { ...rest, occurrences: occurrences.map(({ kind: _k, ...o }) => o), ...over };
}
