import type { TargetKey } from '../storage/target';
import type { DeepReadonly } from '../util/deepReadonly';
import { normalizeHashes } from './history';
import type { AliasBinding, AliasResolution } from './types';

/** Per-device, per-vault state. Never synced (stored with App.saveLocalStorage). */
export interface DeviceState {
	profiles: Record<string, { profile: string; generation: number }>;
	mirror: { aliasBindings: AliasBinding[]; aliasResolutions: AliasResolution[]; privateBuckets: TargetKey[]; privateFiles: string[] };
}

export const DEVICE_STORAGE_KEY = 'vault-s3-bridge:device';

export interface DeviceStorage {
	load(key: string): unknown;
	save(key: string, data: unknown): void;
}

export function emptyDeviceState(): DeviceState {
	return { profiles: {}, mirror: { aliasBindings: [], aliasResolutions: [], privateBuckets: [], privateFiles: [] } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function loadDeviceState(storage: DeviceStorage): DeviceState {
	const raw = storage.load(DEVICE_STORAGE_KEY);
	const state = emptyDeviceState();
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
