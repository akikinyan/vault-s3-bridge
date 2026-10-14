import { describe, expect, it } from 'vitest';
import { emptyDeviceState, loadDeviceState, profileOf, saveDeviceState, setProfile } from '../src/settings/device';
import { loadSettings, serializeSettings } from '../src/settings/migrate';
import { checkNewConnection, recordsOf } from '../src/settings/registry';
import { DEFAULT_SETTINGS } from '../src/settings/types';

const v1 = {
	schemaVersion: 1,
	connections: [
		{ id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', auth: { type: 'aws-sso-profile', profile: 'sso-a' }, bucket: 'x', region: 'ap-northeast-1' },
		{ id: 'c2', alias: 'blog', provider: 'aws-s3', classification: 'public', auth: { type: 'aws-sso-profile', profile: 'sso-b' }, bucket: 'p', region: 'ap-northeast-1', publicBaseUrl: 'https://cdn.example.com' },
	],
	network: { timeoutMs: 15000 },
	language: 'ja',
};

describe('loadSettings — v1 to v2', () => {
	it('moves profiles to the device and out of data.json', () => {
		const device = emptyDeviceState();
		const { settings, changed } = loadSettings(v1, device);
		expect(profileOf(device, 'c1')).toEqual({ profile: 'sso-a', generation: 1 });
		expect(profileOf(device, 'c2')).toEqual({ profile: 'sso-b', generation: 1 });
		expect(JSON.stringify(serializeSettings(settings))).not.toContain('sso-a');
		expect(changed).toBe(true);
	});

	it('does not overwrite a profile already set on this device', () => {
		const device = emptyDeviceState();
		setProfile(device, 'c1', 'local-choice');
		loadSettings(v1, device);
		expect(profileOf(device, 'c1')?.profile).toBe('local-choice');
	});

	it('records existing connections, including private buckets in the ledger', () => {
		const device = emptyDeviceState();
		const { settings } = loadSettings(v1, device);
		expect(settings.privateBuckets).toEqual(['aws:x']);
		expect(settings.aliasBindings.map((b) => b.alias)).toEqual(['blog', 'work']);
		// Delete the migrated private connection without editing it, then try to publish its bucket.
		settings.connections = settings.connections.filter((c) => c.id !== 'c1');
		const reuse = { id: 'n', alias: 'other', provider: 'aws-s3' as const, classification: 'public' as const, bucket: 'x', region: 'ap-northeast-1' };
		expect(checkNewConnection(recordsOf(settings), reuse)).toBe('private-bucket-public');
	});
});

describe('loadSettings — sync and compatibility', () => {
	it('restores records from the device mirror when data.json lost them', () => {
		const device = emptyDeviceState();
		const first = loadSettings(v1, device).settings;
		const shrunk = { ...serializeSettings(first), aliasBindings: [], privateBuckets: [], connections: [] };
		const { settings, changed } = loadSettings(shrunk, device);
		expect(settings.privateBuckets).toEqual(['aws:x']);
		expect(settings.aliasBindings).toHaveLength(2);
		expect(changed).toBe(true);
	});

	it('reports no change for already-normalized data (no sync ping-pong)', () => {
		const device = emptyDeviceState();
		const first = loadSettings(v1, device).settings;
		const { changed } = loadSettings(serializeSettings(first), device);
		expect(changed).toBe(false);
	});

	it('keeps unknown fields and becomes read-only for newer schemas', () => {
		const device = emptyDeviceState();
		const newer = { ...v1, schemaVersion: 3, futureFeature: { a: 1 } };
		const { settings, readOnly, changed } = loadSettings(newer, device);
		expect(readOnly).toBe(true);
		expect(changed).toBe(false);
		expect(serializeSettings(settings).futureFeature).toEqual({ a: 1 });
	});

	it('returns defaults for empty data and drops invalid connections', () => {
		expect(loadSettings(null, emptyDeviceState()).settings).toEqual(DEFAULT_SETTINGS);
		const { settings } = loadSettings({ connections: [{ id: 'x', alias: 'Bad Alias', bucket: 'b' }, 'junk', { ...v1.connections[0], classification: 'weird' }] }, emptyDeviceState());
		expect(settings.connections).toHaveLength(1);
		expect(settings.connections[0]?.classification).toBe('private');
	});

	it('keeps path-style access only with a custom endpoint', () => {
		const { settings } = loadSettings(
			{ connections: [{ ...v1.connections[0], forcePathStyle: true }, { ...v1.connections[0], id: 'm', alias: 'minio', bucket: 'm', endpoint: 'https://minio.example.com', forcePathStyle: true }] },
			emptyDeviceState(),
		);
		expect(settings.connections.map((c) => c.forcePathStyle)).toEqual([undefined, true]);
	});
});

describe('device state', () => {
	it('advances the generation when the profile changes', () => {
		const d = emptyDeviceState();
		setProfile(d, 'c', 'a');
		setProfile(d, 'c', 'a');
		expect(profileOf(d, 'c')?.generation).toBe(1);
		setProfile(d, 'c', 'b');
		expect(profileOf(d, 'c')).toEqual({ profile: 'b', generation: 2 });
		setProfile(d, 'c', undefined);
		expect(profileOf(d, 'c')).toBeUndefined();
		setProfile(d, 'c', 'b');
		expect(profileOf(d, 'c')?.generation).toBe(4);
	});

	it('round-trips through storage and ignores malformed data', () => {
		const store = new Map<string, unknown>();
		const storage = { load: (k: string) => store.get(k), save: (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))) };
		const d = emptyDeviceState();
		setProfile(d, 'c', 'a');
		saveDeviceState(storage, d);
		expect(loadDeviceState(storage)).toEqual(d);
		store.set('vault-s3-bridge:device', { profiles: { bad: { profile: 1 } }, mirror: 'x' });
		expect(loadDeviceState(storage)).toEqual(emptyDeviceState());
	});
});
