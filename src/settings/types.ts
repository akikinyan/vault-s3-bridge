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
	/** Object key template for uploads. Stored explicitly so that changing the default never moves existing keys. */
	keyTemplate: string;
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

export type UploadFormat = 'png' | 'jpeg' | 'webp' | 'gif';

export interface UploadSettings {
	/** Connection chosen by default in the upload dialog. */
	defaultConnectionId?: string;
	webp: { enabled: boolean; quality: number };
	/** Strip metadata for private uploads too (always stripped for public ones). */
	stripPrivate: boolean;
	maxFileMB: number;
	maxJobMB: number;
	/** Normalised vault folder paths whose notes are never uploaded from. */
	excludeFolders: string[];
}

/** One object this vault uploaded or reused. Merged as a set across devices, then trimmed to the limit. */
export interface HistoryEntry {
	id: string;
	target: TargetKey;
	key: string;
	classification: Classification;
	/** SHA-256 (lowercase hex) of the original file. */
	sourceSha256: string;
	/** SHA-256 (lowercase hex) of the bytes sent. */
	sentSha256: string;
	size: number;
	format: UploadFormat;
	converter: string;
	/** ISO 8601, UTC. */
	at: string;
}

export interface PluginSettings {
	schemaVersion: 3;
	connections: StorageConnection[];
	aliasBindings: AliasBinding[];
	aliasResolutions: AliasResolution[];
	privateBuckets: TargetKey[];
	/** Grow-only: SHA-256 (lowercase hex) of every file sent, or about to be sent, to private storage. */
	privateFiles: string[];
	history: HistoryEntry[];
	historyLimit: number;
	upload: UploadSettings;
	network: NetworkSettings;
	preview: PreviewSettings;
	language: LanguageSetting;
	/** Fields written by newer versions are kept as-is. */
	extra?: Record<string, unknown>;
}

export const CURRENT_SCHEMA_VERSION = 3;
export const CONNECT_TIMEOUT_MS = 5_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const CLEANUP_TIMEOUT_MS = 10_000;

export const DEFAULT_PREVIEW: PreviewSettings = { maxFileMB: 20, maxMegapixels: 40, cacheMB: 100 };

export const DEFAULT_KEY_TEMPLATE: Record<Classification, string> = {
	// Public URLs reveal the key: no note or file names by default.
	public: 'attachments/{year}/{mon}/{hash}.{ext}',
	private: 'attachments/{year}/{mon}/{notename}/{filename}.{ext}',
};

export const DEFAULT_UPLOAD: UploadSettings = {
	webp: { enabled: false, quality: 0.85 },
	stripPrivate: false,
	maxFileMB: 20,
	maxJobMB: 200,
	excludeFolders: [],
};

export const DEFAULT_HISTORY_LIMIT = 2000;

export const DEFAULT_SETTINGS: PluginSettings = {
	schemaVersion: CURRENT_SCHEMA_VERSION,
	connections: [],
	aliasBindings: [],
	aliasResolutions: [],
	privateBuckets: [],
	privateFiles: [],
	history: [],
	historyLimit: DEFAULT_HISTORY_LIMIT,
	upload: { ...DEFAULT_UPLOAD, webp: { ...DEFAULT_UPLOAD.webp }, excludeFolders: [] },
	network: { timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
	preview: { ...DEFAULT_PREVIEW },
	language: 'auto',
};
