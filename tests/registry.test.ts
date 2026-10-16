import { describe, expect, it } from 'vitest';
import {
	checkEditedConnection,
	checkNewConnection,
	connectionState,
	mergeRecords,
	recordConnection,
	recordsEqual,
	resolveAlias,
	resolveConflict,
	type Records,
} from '../src/settings/registry';
import type { StorageConnection } from '../src/settings/types';
import { validateConnectionFields, validateProxyUrl } from '../src/settings/validate';

const empty: Records = { aliasBindings: [], aliasResolutions: [], privateBuckets: [], privateFiles: [] };
const conn = (o: Partial<StorageConnection> = {}): StorageConnection => ({
	id: 'id-' + (o.alias ?? 'work') + (o.bucket ?? 'x'),
	alias: 'work',
	provider: 'aws-s3',
	classification: 'private',
	bucket: 'x',
	region: 'ap-northeast-1',
	keyTemplate: 'k/{hash}.{ext}',
	...o,
});
const X = conn({ bucket: 'x' });
const Y = conn({ bucket: 'y' });

describe('merge (sync safety)', () => {
	it('keeps entries that an external change removed', () => {
		const local = recordConnection(empty, X);
		const external = empty; // a stale device wrote data.json without the entry
		const merged = mergeRecords(external, local);
		expect(merged.privateBuckets).toEqual(['aws:x']);
		expect(merged.aliasBindings).toHaveLength(1);
	});

	it('keeps additions from two devices', () => {
		const a = recordConnection(empty, conn({ alias: 'a', bucket: 'p' }));
		const b = recordConnection(empty, conn({ alias: 'b', bucket: 'q' }));
		const merged = mergeRecords(a, b);
		expect(merged.aliasBindings.map((x) => x.alias)).toEqual(['a', 'b']);
		expect(merged.privateBuckets).toEqual(['aws:p', 'aws:q']);
	});

	it('is order independent and detects no change when nothing changed', () => {
		const a = recordConnection(empty, X);
		const b = recordConnection(empty, conn({ alias: 'b', bucket: 'q', classification: 'public' }));
		expect(mergeRecords(a, b)).toEqual(mergeRecords(b, a));
		expect(recordsEqual(mergeRecords(a, b), mergeRecords(b, a, a))).toBe(true);
	});
});

describe('resolveAlias', () => {
	it('resolves a single binding', () => {
		expect(resolveAlias(recordConnection(empty, X), 'work')).toEqual({ kind: 'resolved', target: 'aws:x', classification: 'private' });
		expect(resolveAlias(empty, 'work')).toEqual({ kind: 'unbound' });
	});

	it('reports a conflict when two devices bound the alias to different targets', () => {
		const synced = mergeRecords(recordConnection(empty, X), recordConnection(empty, Y));
		expect(resolveAlias(synced, 'work')).toEqual({ kind: 'conflict', candidates: ['aws:x', 'aws:y'] });
	});

	it('stays in conflict on every device when devices resolve in opposite ways', () => {
		const synced = mergeRecords(recordConnection(empty, X), recordConnection(empty, Y));
		const deviceA = resolveConflict(synced, 'work', 'aws:x', 'r-a');
		const deviceB = resolveConflict(synced, 'work', 'aws:y', 'r-b');
		expect(resolveAlias(deviceA, 'work')).toMatchObject({ kind: 'resolved', target: 'aws:x' });
		expect(resolveAlias(deviceB, 'work')).toMatchObject({ kind: 'resolved', target: 'aws:y' });
		const afterSyncOnA = mergeRecords(deviceA, deviceB);
		const afterSyncOnB = mergeRecords(deviceB, deviceA);
		expect(resolveAlias(afterSyncOnA, 'work').kind).toBe('conflict');
		expect(resolveAlias(afterSyncOnB, 'work')).toEqual(resolveAlias(afterSyncOnA, 'work'));
	});

	it('converges after a resolution that covers all earlier resolutions', () => {
		const synced = mergeRecords(recordConnection(empty, X), recordConnection(empty, Y));
		const both = mergeRecords(resolveConflict(synced, 'work', 'aws:x', 'r-a'), resolveConflict(synced, 'work', 'aws:y', 'r-b'));
		const again = resolveConflict(both, 'work', 'aws:y', 'r-c');
		expect(again.aliasResolutions.find((r) => r.id === 'r-c')?.knownResolutions).toEqual(['r-a', 'r-b']);
		const otherDevice = mergeRecords(both, again);
		expect(resolveAlias(otherDevice, 'work')).toMatchObject({ kind: 'resolved', target: 'aws:y' });
		// Order independence
		expect(resolveAlias(mergeRecords(again, both), 'work')).toEqual(resolveAlias(otherDevice, 'work'));
	});

	it('treats a target as private if any binding or the ledger says so', () => {
		const r = mergeRecords(recordConnection(empty, conn({ classification: 'public' })), { ...empty, privateBuckets: ['aws:x'] });
		expect(resolveAlias(r, 'work')).toMatchObject({ classification: 'private' });
	});
});

describe('connection rules', () => {
	it('forbids rebinding a live or deleted alias to another target', () => {
		const r = recordConnection(empty, X);
		expect(checkNewConnection(r, Y)).toBe('alias-bound-elsewhere');
		expect(checkNewConnection(r, X)).toBeUndefined(); // restore
	});

	it('forbids changing alias, bucket or endpoint and private to public', () => {
		const r = recordConnection(empty, X);
		expect(checkEditedConnection(r, X, { ...X, bucket: 'y' })).toBe('immutable-field');
		expect(checkEditedConnection(r, X, { ...X, alias: 'other' })).toBe('immutable-field');
		expect(checkEditedConnection(r, X, { ...X, endpoint: 'https://s3.amazonaws.com' })).toBe('immutable-field');
		expect(checkEditedConnection(r, X, { ...X, classification: 'public' })).toBe('private-to-public-forbidden');
		expect(checkEditedConnection(r, X, { ...X, region: 'us-east-1', displayName: 'Work' })).toBeUndefined();
	});

	it('keeps a deleted private bucket out of public connections, even with an explicit AWS endpoint', () => {
		const r = recordConnection(empty, X); // connection later deleted; records stay
		const reuse = conn({ alias: 'blog', bucket: 'x', classification: 'public', endpoint: 'https://s3.ap-northeast-1.amazonaws.com' });
		expect(checkNewConnection(r, reuse)).toBe('private-bucket-public');
	});

	it('allows public to private', () => {
		const pub = conn({ classification: 'public' });
		const r = recordConnection(empty, pub);
		expect(checkEditedConnection(r, pub, { ...pub, classification: 'private' })).toBeUndefined();
		expect(recordConnection(r, { ...pub, classification: 'private' }).privateBuckets).toEqual(['aws:x']);
	});

	it('supports the full cycle: conflict, resolve, recreate the chosen connection', () => {
		const synced = mergeRecords(recordConnection(empty, X), recordConnection(empty, Y));
		// Only Y survived in the connection list (last writer wins).
		expect(connectionState(synced, Y)).toBe('conflict');
		expect(checkNewConnection(synced, X)).toBe('alias-conflict');
		const resolved = resolveConflict(synced, 'work', 'aws:x', 'r1');
		expect(connectionState(resolved, Y)).toBe('superseded');
		expect(checkNewConnection(resolved, X)).toBeUndefined();
		expect(connectionState(recordConnection(resolved, X), X)).toBe('active');
	});

	it('blocks a synced public connection whose bucket became private elsewhere', () => {
		const pub = conn({ alias: 'blog', bucket: 'q', classification: 'public' });
		const fromOtherDevice = recordConnection(empty, conn({ alias: 'work', bucket: 'q', classification: 'private' }));
		const merged = mergeRecords(recordConnection(empty, pub), fromOtherDevice);
		expect(connectionState(merged, pub)).toBe('blocked');
	});
});

describe('field validation', () => {
	it('checks required fields, alias format and duplicates', () => {
		expect(validateConnectionFields(X, [])).toEqual([]);
		expect(validateConnectionFields({ ...X, alias: 'Work!' }, [])).toContain('alias-invalid');
		expect(validateConnectionFields(X, [{ ...X, id: 'other' }])).toContain('alias-duplicate');
		expect(validateConnectionFields({ ...X, bucket: '', region: '' }, [])).toEqual(expect.arrayContaining(['bucket-required', 'region-required']));
		expect(validateConnectionFields({ ...X, endpoint: 'http://minio.local' }, [])).toContain('endpoint-invalid');
	});

	it('validates proxy URLs', () => {
		expect(validateProxyUrl('http://user:pass@proxy.example.com')).toBe('proxy-credentials-unsupported');
		expect(validateProxyUrl('http://proxy.example.com:8080')).toBeUndefined();
	});
});
