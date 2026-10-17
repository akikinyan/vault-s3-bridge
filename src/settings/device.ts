import type { TargetKey } from '../storage/target';
import type { DeepReadonly } from '../util/deepReadonly';
import { normalizeHashes } from './history';
import type { AliasBinding, AliasResolution } from './types';

/** Per-device, per-vault state. Never synced (stored with App.saveLocalStorage). */
export interface DeviceState {
	/** Random id of this device for this vault. Names the device's resume-record file. */
	deviceId: string;
	profiles: Record<string, { profile: string; generation: number }>;
	mirror: { aliasBindings: AliasBinding[]; aliasResolutions: AliasResolution[]; privateBuckets: TargetKey[]; privateFiles: string[] };
}

export const DEVICE_STORAGE_KEY = 'vault-s3-bridge:device';

export interface DeviceStorage {
	load(key: string): unknown;
	save(key: string, data: unknown): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A device id is used in a file name, so only the exact UUID form is accepted. */
export function isDeviceId(value: unknown): value is string {
	return typeof value === 'string' && UUID.test(value);
}

export function emptyDeviceState(deviceId = ''): DeviceState {
	return { deviceId, profiles: {}, mirror: { aliasBindings: [], aliasResolutions: [], privateBuckets: [], privateFiles: [] } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Reads the device state. A missing or malformed device id is replaced and saved at once, without waiting for
 * a settings save (which may be impossible while data.json is read-only); the rest of the stored value is kept.
 */
export function loadDeviceState(storage: DeviceStorage, newId: () => string = () => crypto.randomUUID()): DeviceState {
	const raw = storage.load(DEVICE_STORAGE_KEY);
	const state = emptyDeviceState(isRecord(raw) && isDeviceId(raw.deviceId) ? raw.deviceId : newId());
	if (!isRecord(raw) || raw.deviceId !== state.deviceId) {
		try {
			storage.save(DEVICE_STORAGE_KEY, { ...(isRecord(raw) ? raw : {}), deviceId: state.deviceId });
		} catch {
			// Kept in memory; the next successful settings pass saves the whole device state.
		}
	}
	if (!isRecord(raw)) return state;
	if (isRecord(raw.profiles)) {
		for (const [id, v] of Object.entries(raw.profiles)) {
			if (isRecord(v) && typeof v.profile === 'string' && typeof v.generation === 'number') {
				state.profiles[id] = { profile: v.profile, generation: v.generation };
			}
		}
	}
	if (isRecord(raw.mirror)) {
		const m = raw.mirror;
		if (Array.isArray(m.aliasBindings)) state.mirror.aliasBindings = m.aliasBindings as AliasBinding[];
		if (Array.isArray(m.aliasResolutions)) state.mirror.aliasResolutions = m.aliasResolutions as AliasResolution[];
		if (Array.isArray(m.privateBuckets)) state.mirror.privateBuckets = m.privateBuckets.filter((x): x is string => typeof x === 'string');
		state.mirror.privateFiles = normalizeHashes(m.privateFiles);
	}
	return state;
}

export function saveDeviceState(storage: DeviceStorage, state: DeepReadonly<DeviceState>): void {
	storage.save(DEVICE_STORAGE_KEY, state);
}

/** Sets the profile for a connection on this device and advances its authentication generation. */
export function setProfile(state: DeviceState, connectionId: string, profile: string | undefined): void {
	const current = state.profiles[connectionId];
	if (!profile) {
		if (current) state.profiles[connectionId] = { profile: '', generation: current.generation + 1 };
		return;
	}
	if (current?.profile === profile) return;
	state.profiles[connectionId] = { profile, generation: (current?.generation ?? 0) + 1 };
}

export function profileOf(state: DeepReadonly<DeviceState>, connectionId: string): { profile: string; generation: number } | undefined {
	const p = state.profiles[connectionId];
	return p && p.profile ? p : undefined;
}
