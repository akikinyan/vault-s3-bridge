import { describe, expect, it } from 'vitest';
import { checkConnectionSave } from '../src/settings/connectionSave';
import { mergeRecords, recordsOf } from '../src/settings/registry';
import { connection, settingsWith } from './fixtures/preview';

describe('checkConnectionSave', () => {
	it('accepts an unchanged edit', () => {
		const stored = connection();
		expect(checkConnectionSave(settingsWith(stored), stored, { ...stored, region: 'us-east-1' })).toEqual([]);
	});

	it('rejects a public connection for a bucket that became private after the editor opened', () => {
		const publicOne = connection({ id: 'c-pub', alias: 'pub', classification: 'public', bucket: 'shared' });
		const settings = settingsWith(publicOne);
		const other = settingsWith(connection({ id: 'c-priv', alias: 'priv', bucket: 'shared' }));
		Object.assign(settings, mergeRecords(recordsOf(settings), recordsOf(other))); // sync brought a private ledger entry
		expect(checkConnectionSave(settings, publicOne, { ...publicOne, region: 'us-east-1' })).toContain('error.private-bucket-public');
		const fresh = connection({ id: 'c-new', alias: 'fresh', classification: 'public', bucket: 'shared' });
		expect(checkConnectionSave(settings, undefined, fresh)).toContain('error.private-bucket-public');
	});

	it('detects a connection that was deleted or changed meanwhile', () => {
		const opened = connection();
		expect(checkConnectionSave(settingsWith(), opened, opened)).toEqual(['error.connection-deleted']);
		const changed = settingsWith(connection({ region: 'eu-west-1' }));
		expect(checkConnectionSave(changed, opened, opened)).toEqual(['error.connection-changed']);
		expect(checkConnectionSave(settingsWith(opened), undefined, opened)).toEqual(['error.connection-changed']);
	});
});
