import { describe, expect, it } from 'vitest';
import { emptyDeviceState, loadDeviceState, profileOf, saveDeviceState, setProfile } from '../src/settings/device';
import { loadSettings, serializeSettings } from '../src/settings/migrate';
import { checkNewConnection, recordsOf } from '../src/settings/registry';
import { DEFAULT_SETTINGS } from '../src/settings/types';

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
		const reuse = { id: 'n', alias: 'other', provider: 'aws-s3' as const, classification: 'public' as const, bucket: 'x', region: 'ap-northeast-1', keyTemplate: 'k' };
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
		const newer = { ...v1, schemaVersion: 5, futureFeature: { a: 1 } };
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
		const d = emptyDeviceState(ID_A);
		setProfile(d, 'c', 'a');
		saveDeviceState(storage, d);
		expect(loadDeviceState(storage)).toEqual(d);
		store.set('vault-s3-bridge:device', { deviceId: ID_A, profiles: { bad: { profile: 1 } }, mirror: 'x' });
		expect(loadDeviceState(storage)).toEqual(emptyDeviceState(ID_A));
	});

	it('creates a device id once and saves it at once, keeping the rest of the stored value', () => {
		const store = new Map<string, unknown>();
		const storage = { load: (k: string) => store.get(k), save: (k: string, v: unknown) => void store.set(k, JSON.parse(JSON.stringify(v))) };
		let n = 0;
		const ids = [ID_A, ID_B];
		const newId = () => ids[n++]!;
		expect(loadDeviceState(storage, newId).deviceId).toBe(ID_A);
		expect(store.get('vault-s3-bridge:device')).toEqual({ deviceId: ID_A });
		expect(loadDeviceState(storage, newId).deviceId).toBe(ID_A); // not replaced on the next load
		// Malformed state elsewhere keeps the id; the stored value is not normalised away.
		store.set('vault-s3-bridge:device', { deviceId: ID_A, mirror: 'x' });
		expect(loadDeviceState(storage, newId).deviceId).toBe(ID_A);
		expect(store.get('vault-s3-bridge:device')).toEqual({ deviceId: ID_A, mirror: 'x' });
		// An id that is not exactly a UUID (it names a file) is replaced.
		store.set('vault-s3-bridge:device', { deviceId: '../x', profiles: {} });
		expect(loadDeviceState(storage, newId).deviceId).toBe(ID_B);
		expect(store.get('vault-s3-bridge:device')).toEqual({ deviceId: ID_B, profiles: {} });
		expect(n).toBe(2);
	});

	it('keeps the new id in memory when saving it fails', () => {
		const storage = { load: () => undefined, save: () => { throw new Error('quota'); } };
		expect(loadDeviceState(storage, () => ID_B).deviceId).toBe(ID_B);
	});
});

describe('loadSettings — cache budget', () => {
	it('keeps a cache size of 0 and falls back only for invalid values', () => {
		const zero = loadSettings({ schemaVersion: 2, preview: { cacheMB: 0 } }, emptyDeviceState()).settings;
		expect(zero.preview.cacheMB).toBe(0);
		const bad = loadSettings({ schemaVersion: 2, preview: { cacheMB: -1 } }, emptyDeviceState()).settings;
		expect(bad.preview.cacheMB).toBe(DEFAULT_SETTINGS.preview.cacheMB);
		const reloaded = loadSettings(serializeSettings(zero), emptyDeviceState()).settings;
		expect(reloaded.preview.cacheMB).toBe(0);
	});
});

describe('loadSettings — proxy mode', () => {
	const load = (network: Record<string, unknown>) => loadSettings({ schemaVersion: 4, network: { timeoutMs: 15000, ...network } }, emptyDeviceState());

	it('derives the mode from the proxy URL for settings saved before it existed', () => {
		expect(load({}).settings.network.proxyMode).toBe('none');
		expect(load({ proxyUrl: '  ' }).settings.network.proxyMode).toBe('none');
		const withUrl = load({ proxyUrl: 'http://proxy.example.com:8080', noProxy: 'internal.example' });
		expect(withUrl.settings.network).toEqual({ proxyMode: 'url', proxyUrl: 'http://proxy.example.com:8080', noProxy: 'internal.example', timeoutMs: 15000 });
		expect(withUrl.changed).toBe(true);
	});

	it('keeps each mode, and the URL when another mode is chosen', () => {
		for (const proxyMode of ['none', 'url', 'system']) {
			const { settings } = load({ proxyMode, proxyUrl: 'http://proxy.example.com:8080' });
			expect(settings.network).toMatchObject({ proxyMode, proxyUrl: 'http://proxy.example.com:8080' });
			const reloaded = loadSettings(serializeSettings(settings), emptyDeviceState());
			expect(reloaded.settings.network.proxyMode).toBe(proxyMode);
			expect(reloaded.changed).toBe(false);
		}
	});

	it('connects directly for an unknown mode (fail safe)', () => {
		expect(load({ proxyMode: 'pac', proxyUrl: 'http://proxy.example.com:8080' }).settings.network.proxyMode).toBe('none');
		expect(load({ proxyMode: 1 }).settings.network.proxyMode).toBe('none');
	});

	it('defaults to no proxy', () => {
		expect(loadSettings({}, emptyDeviceState()).settings.network.proxyMode).toBe('none');
		expect(DEFAULT_SETTINGS.network.proxyMode).toBe('none');
	});
});
