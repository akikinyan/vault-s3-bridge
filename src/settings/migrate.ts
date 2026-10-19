import { isValidAlias } from '../reference/reference';
import { setProfile, type DeviceState } from './device';
import { mergeRecords, normalizeRecords, recordConnection, type Records } from './registry';
import { mergeHistory } from './history';
import {
	CURRENT_SCHEMA_VERSION,
	DEFAULT_HISTORY_LIMIT,
	DEFAULT_KEY_TEMPLATE,
	DEFAULT_PREVIEW,
	DEFAULT_REQUEST_TIMEOUT_MS,
	DEFAULT_UPLOAD,
	type LanguageSetting,
	type PluginSettings,
	type StorageConnection,
	type UploadSettings,
} from './types';

const KNOWN_KEYS = new Set([
	'schemaVersion',
	'connections',
	'aliasBindings',
	'aliasResolutions',
	'privateBuckets',
	'privateFiles',
	'history',
	'historyLimit',
	'upload',
	'network',
	'preview',
	'language',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function positive(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegative(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function between(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function normalizeUpload(raw: unknown): UploadSettings {
	const u = isRecord(raw) ? raw : {};
	const webp = isRecord(u.webp) ? u.webp : {};
	const folders = Array.isArray(u.excludeFolders) ? u.excludeFolders : [];
	return {
		defaultConnectionId: str(u.defaultConnectionId),
		webp: { enabled: webp.enabled === true, quality: between(webp.quality, 0.5, 1, DEFAULT_UPLOAD.webp.quality) },
		stripPrivate: u.stripPrivate === true,
		maxFileMB: between(u.maxFileMB, 1, 100, DEFAULT_UPLOAD.maxFileMB),
		maxOtherFileMB: between(u.maxOtherFileMB, 1, 100, DEFAULT_UPLOAD.maxOtherFileMB),
		maxJobMB: between(u.maxJobMB, 10, 1000, DEFAULT_UPLOAD.maxJobMB),
		excludeFolders: [...new Set(folders.map(str).filter((f): f is string => f !== undefined).map((f) => f.replace(/^\/+|\/+$/g, '')))].filter((f) => f !== '').sort(),
	};
}

function migrateConnection(raw: unknown): { connection: StorageConnection; legacyProfile?: string } | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id);
	const alias = str(raw.alias);
	const bucket = str(raw.bucket);
	if (!id || !alias || !isValidAlias(alias) || !bucket) return undefined;
	const endpoint = str(raw.endpoint);
	const classification = raw.classification === 'public' ? 'public' : 'private'; // fail safe
	const auth = isRecord(raw.auth) ? raw.auth : undefined;
	return {
		connection: {
			id,
			alias,
			displayName: str(raw.displayName),
			provider: 'aws-s3',
			classification,
			bucket,
			region: str(raw.region) ?? '',
			endpoint,
			// Path-style access applies only to a custom endpoint (S3-compatible storage).
			forcePathStyle: raw.forcePathStyle === true && endpoint ? true : undefined,
			publicBaseUrl: classification === 'public' ? str(raw.publicBaseUrl) : undefined,
			// v1/v2 had no template: store the default of the classification explicitly (keys stay stable later).
			keyTemplate: str(raw.keyTemplate) ?? DEFAULT_KEY_TEMPLATE[classification],
		},
		legacyProfile: auth && auth.type === 'aws-sso-profile' ? str(auth.profile) : undefined,
	};
}

export interface LoadResult {
	settings: PluginSettings;
	/** True when data.json was written by a newer schema; such data must not be saved back. */
	readOnly: boolean;
	/** True when the normalized settings differ from what was stored, so they should be saved. */
	changed: boolean;
}

/**
 * Normalizes stored data into the current schema and merges grow-only records with the
 * device mirror. Updates `device` (moved profiles, mirror) in place.
 */
export function loadSettings(raw: unknown, device: DeviceState): LoadResult {
	const data = isRecord(raw) ? raw : {};
	const storedVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : 1;
	const readOnly = storedVersion > CURRENT_SCHEMA_VERSION;

	const connections: StorageConnection[] = [];
	for (const item of Array.isArray(data.connections) ? data.connections : []) {
		const migrated = migrateConnection(item);
		if (!migrated) continue;
		connections.push(migrated.connection);
		// v1 kept the profile in data.json; move it to this device unless already set here.
		if (migrated.legacyProfile && !device.profiles[migrated.connection.id]) {
			setProfile(device, migrated.connection.id, migrated.legacyProfile);
		}
	}

	let records: Records = mergeRecords(normalizeRecords(data), normalizeRecords(device.mirror));
	for (const c of connections) records = recordConnection(records, c);
	device.mirror = records;

	const network = isRecord(data.network) ? data.network : {};
	const preview = isRecord(data.preview) ? data.preview : {};
	const language: LanguageSetting = data.language === 'ja' || data.language === 'en' ? data.language : 'auto';
	const extra: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) if (!KNOWN_KEYS.has(k)) extra[k] = v;

	const settings: PluginSettings = {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		connections,
		...records,
		network: {
			proxyUrl: str(network.proxyUrl),
			noProxy: str(network.noProxy),
			timeoutMs: positive(network.timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
		},
		preview: {
			maxFileMB: positive(preview.maxFileMB, DEFAULT_PREVIEW.maxFileMB),
			maxPdfMB: between(preview.maxPdfMB, 1, 100, DEFAULT_PREVIEW.maxPdfMB),
			maxTextMB: between(preview.maxTextMB, 1, 20, DEFAULT_PREVIEW.maxTextMB),
			maxMegapixels: positive(preview.maxMegapixels, DEFAULT_PREVIEW.maxMegapixels),
			cacheMB: nonNegative(preview.cacheMB, DEFAULT_PREVIEW.cacheMB),
		},
		language,
		history: mergeHistory(data.history),
		historyLimit: Math.round(between(data.historyLimit, 100, 20000, DEFAULT_HISTORY_LIMIT)),
		upload: normalizeUpload(data.upload),
		extra: Object.keys(extra).length > 0 ? extra : undefined,
	};
	const changed = !readOnly && stableStringify(serializeSettings(settings)) !== stableStringify(raw ?? {});
	return { settings, readOnly, changed };
}

/** The object written to data.json. Unknown fields from newer versions are preserved. */
export function serializeSettings(settings: PluginSettings): Record<string, unknown> {
	const { extra, ...known } = settings;
	return JSON.parse(JSON.stringify({ ...(extra ?? {}), ...known })) as Record<string, unknown>;
}

export function stableStringify(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		isRecord(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
	);
}
