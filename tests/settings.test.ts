import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../src/settings/migrate';
import { DEFAULT_SETTINGS, type StorageConnection } from '../src/settings/types';
import { changesPrivateTarget, validateConnection } from '../src/settings/validate';

const base: StorageConnection = {
	id: 'id-1',
	alias: 'work',
	provider: 'aws-s3',
	classification: 'private',
	auth: { type: 'aws-sso-profile', profile: 'p' },
	bucket: 'b',
	region: 'ap-northeast-1',
};

describe('migrateSettings', () => {
	it('returns defaults for empty data', () => {
		expect(migrateSettings(null)).toEqual(DEFAULT_SETTINGS);
		expect(migrateSettings({})).toEqual(DEFAULT_SETTINGS);
	});

	it('treats unknown classification as private and drops invalid entries', () => {
		const s = migrateSettings({
			connections: [{ ...base, classification: 'something' }, { id: 'x' }, 'junk'],
			network: { timeoutMs: -1 },
			language: 'fr',
		});
		expect(s.connections).toHaveLength(1);
		expect(s.connections[0]?.classification).toBe('private');
		expect(s.network.timeoutMs).toBe(DEFAULT_SETTINGS.network.timeoutMs);
		expect(s.language).toBe('auto');
	});

	it('drops publicBaseUrl from private connections', () => {
		const s = migrateSettings({ connections: [{ ...base, publicBaseUrl: 'https://cdn.example.com' }] });
		expect(s.connections[0]?.publicBaseUrl).toBeUndefined();
	});
});

describe('validateConnection', () => {
	it('accepts a valid connection', () => {
		expect(validateConnection(base, undefined, [])).toEqual([]);
	});

	it('forbids private to public', () => {
		expect(validateConnection({ ...base, classification: 'public' }, base, [base])).toContain('private-to-public-forbidden');
	});

	it('allows public to private', () => {
		const pub = { ...base, classification: 'public' as const };
		expect(validateConnection(base, pub, [pub])).toEqual([]);
	});

	it('checks required fields, alias format and duplicates', () => {
		const other = { ...base, id: 'id-2' };
		expect(validateConnection({ ...base, alias: 'Work!' }, undefined, [])).toContain('alias-invalid');
		expect(validateConnection(base, undefined, [other])).toContain('alias-duplicate');
		expect(validateConnection({ ...base, bucket: '', region: '', auth: { type: 'aws-sso-profile', profile: '' } }, undefined, [])).toEqual(
			expect.arrayContaining(['bucket-required', 'region-required', 'profile-required']),
		);
		expect(validateConnection({ ...base, endpoint: 'http://minio.local' }, undefined, [])).toContain('endpoint-invalid');
	});
});

describe('changesPrivateTarget', () => {
	it('detects target changes of private connections only', () => {
		expect(changesPrivateTarget({ ...base, bucket: 'other' }, base)).toBe(true);
		expect(changesPrivateTarget({ ...base, region: 'us-east-1' }, base)).toBe(true);
		expect(changesPrivateTarget({ ...base, endpoint: 'https://x.example' }, base)).toBe(true);
		expect(changesPrivateTarget({ ...base, alias: 'renamed' }, base)).toBe(false);
		expect(changesPrivateTarget(base, undefined)).toBe(false);
		const pub = { ...base, classification: 'public' as const };
		expect(changesPrivateTarget({ ...pub, bucket: 'other' }, pub)).toBe(false);
	});
});
