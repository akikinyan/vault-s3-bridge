export type Classification = 'private' | 'public';

export interface AwsSsoProfileAuth {
	type: 'aws-sso-profile';
	profile: string;
}

export interface StorageConnection {
	/** Internal, immutable identifier. */
	id: string;
	/** User-facing alias. Private references will point to this alias. */
	alias: string;
	provider: 'aws-s3';
	classification: Classification;
	auth: AwsSsoProfileAuth;
	bucket: string;
	region: string;
	endpoint?: string;
	forcePathStyle?: boolean;
	/** Only meaningful for public connections. */
	publicBaseUrl?: string;
}

export interface NetworkSettings {
	proxyUrl?: string;
	noProxy?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
}

export type LanguageSetting = 'auto' | 'ja' | 'en';

export interface PluginSettings {
	schemaVersion: 1;
	connections: StorageConnection[];
	network: NetworkSettings;
	language: LanguageSetting;
}

export const CURRENT_SCHEMA_VERSION = 1;
export const CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const CLEANUP_TIMEOUT_MS = 10_000;

export const DEFAULT_SETTINGS: PluginSettings = {
	schemaVersion: CURRENT_SCHEMA_VERSION,
	connections: [],
	network: { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
	language: 'auto',
};
