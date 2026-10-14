import type { TargetKey } from '../storage/target';

export type Classification = 'private' | 'public';

export interface StorageConnection {
	/** Internal, immutable identifier. */
	id: string;
	/** Written in notes. Immutable once created. */
	alias: string;
	displayName?: string;
	provider: 'aws-s3';
	classification: Classification;
	/** Immutable once created. */
	bucket: string;
	/** May be corrected later; it does not identify the storage. */
	region: string;
	/** Immutable once created. */
	endpoint?: string;
	/** Only meaningful together with a custom endpoint. */
	forcePathStyle?: boolean;
	/** Only meaningful for public connections. */
	publicBaseUrl?: string;
}

/** Grow-only record: an alias was assigned to a storage target. */
export interface AliasBinding {
	alias: string;
	target: TargetKey;
	classification: Classification;
}

/** Grow-only record: the user chose one target for a conflicting alias. */
export interface AliasResolution {
	id: string;
	alias: string;
	chosen: TargetKey;
	knownTargets: TargetKey[];
	knownResolutions: string[];
}

export interface NetworkSettings {
	proxyUrl?: string;
	noProxy?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs: number;
}

export interface PreviewSettings {
	maxFileMB: number;
	maxMegapixels: number;
	cacheMB: number;
}

export type LanguageSetting = 'auto' | 'ja' | 'en';

export interface PluginSettings {
	schemaVersion: 2;
	connections: StorageConnection[];
	aliasBindings: AliasBinding[];
	aliasResolutions: AliasResolution[];
	privateBuckets: TargetKey[];
	network: NetworkSettings;
	preview: PreviewSettings;
	language: LanguageSetting;
	/** Fields written by newer versions are kept as-is. */
	extra?: Record<string, unknown>;
}

export const CURRENT_SCHEMA_VERSION = 2;
export const CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const CLEANUP_TIMEOUT_MS = 10_000;

export const DEFAULT_PREVIEW: PreviewSettings = { maxFileMB: 20, maxMegapixels: 40, cacheMB: 100 };

export const DEFAULT_SETTINGS: PluginSettings = {
	schemaVersion: CURRENT_SCHEMA_VERSION,
	connections: [],
	aliasBindings: [],
	aliasResolutions: [],
	privateBuckets: [],
	network: { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
	preview: { ...DEFAULT_PREVIEW },
	language: 'auto',
};
