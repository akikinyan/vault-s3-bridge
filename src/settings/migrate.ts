import {
	CURRENT_SCHEMA_VERSION,
	DEFAULT_REQUEST_TIMEOUT_MS,
	type LanguageSetting,
	type PluginSettings,
	type StorageConnection,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function migrateConnection(raw: unknown): StorageConnection | undefined {
	if (!isRecord(raw)) return undefined;
	const id = str(raw.id);
	const alias = str(raw.alias);
	const auth = isRecord(raw.auth) ? raw.auth : undefined;
	const profile = auth && auth.type === 'aws-sso-profile' ? str(auth.profile) : undefined;
	if (!id || !alias || !profile) return undefined;
	return {
		id,
		alias,
		provider: 'aws-s3',
		// Anything that is not explicitly public is treated as private (fail safe).
		classification: raw.classification === 'public' ? 'public' : 'private',
		auth: { type: 'aws-sso-profile', profile },
		bucket: str(raw.bucket) ?? '',
		region: str(raw.region) ?? '',
		endpoint: str(raw.endpoint),
		// Path-style access applies only to a custom endpoint (S3-compatible storage).
		forcePathStyle: raw.forcePathStyle === true && str(raw.endpoint) ? true : undefined,
		publicBaseUrl: raw.classification === 'public' ? str(raw.publicBaseUrl) : undefined,
	};
}

/** Normalizes data loaded from data.json into the current settings schema. */
export function migrateSettings(raw: unknown): PluginSettings {
	const data = isRecord(raw) ? raw : {};
	const network = isRecord(data.network) ? data.network : {};
	const timeout = typeof network.timeoutMs === 'number' && network.timeoutMs > 0 ? network.timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
	const language: LanguageSetting = data.language === 'ja' || data.language === 'en' ? data.language : 'auto';
	const connections = Array.isArray(data.connections)
		? data.connections.map(migrateConnection).filter((c): c is StorageConnection => c !== undefined)
		: [];
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		connections,
		network: { proxyUrl: str(network.proxyUrl), noProxy: str(network.noProxy), timeoutMs: timeout },
		language,
	};
}
