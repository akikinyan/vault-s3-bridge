// Operations passed to SettingsStore.mutate. Each one validates against the latest merged settings
// it receives, so a synchronisation that happened while a dialog was open is taken into account.
import { setProfile } from './device';
import { checkConnectionSave } from './connectionSave';
import { recordConnection, recordsOf, resolveConflict } from './registry';
import type { Op } from './store';
import { isSha256Hex, mergeHistory, normalizeHashes } from './history';
import { DEFAULT_SETTINGS, type HistoryEntry, type LanguageSetting, type StorageConnection } from './types';
import { validateProxyUrl } from './validate';
import { cloneData } from '../util/deepReadonly';

export function saveConnectionOp(previous: StorageConnection | undefined, next: StorageConnection, profile: string | undefined): Op<void> {
	return (draft, ctx) => {
		const errors = checkConnectionSave(draft, previous, next);
		if (errors.length > 0) return { ok: false, error: errors };
		const index = draft.connections.findIndex((c) => c.id === next.id);
		if (index >= 0) draft.connections[index] = cloneData(next);
		else draft.connections.push(cloneData(next));
		Object.assign(draft, recordConnection(recordsOf(draft), next));
		setProfile(ctx.device, next.id, profile);
		return { ok: true, value: undefined };
	};
}

export function deleteConnectionOp(id: string): Op<void> {
	return (draft, ctx) => {
		draft.connections = draft.connections.filter((c) => c.id !== id);
		delete ctx.device.profiles[id];
		return { ok: true, value: undefined };
	};
}

export function resolveConflictOp(alias: string, target: string, id: string): Op<void> {
	return (draft) => {
		try {
			Object.assign(draft, resolveConflict(recordsOf(draft), alias, target, id));
		} catch {
			return { ok: false, error: ['error.connection-changed'] };
		}
		return { ok: true, value: undefined };
	};
}

export type FieldKey =
	| 'proxyUrl'
	| 'noProxy'
	| 'timeoutSeconds'
	| 'language'
	| 'maxFileMB'
	| 'maxMegapixels'
	| 'cacheMB'
	| 'defaultConnectionId'
	| 'webpEnabled'
	| 'webpQuality'
	| 'stripPrivate'
	| 'maxPdfMB'
	| 'maxTextMB'
	| 'uploadMaxFileMB'
	| 'uploadMaxOtherFileMB'
	| 'uploadMaxJobMB'
	| 'excludeFolders'
	| 'historyLimit';

/** Same bounds as reading data.json (migrate.ts), so a saved value is never replaced on the next load. */
export const UPLOAD_BOUNDS = {
	webpQualityPercent: { min: 50, max: 100 },
	uploadMaxFileMB: { min: 1, max: 100 },
	uploadMaxOtherFileMB: { min: 1, max: 100 },
	uploadMaxJobMB: { min: 10, max: 1000 },
	historyLimit: { min: 100, max: 20000 },
} as const;

/** Same bounds as reading data.json (migrate.ts). */
export const PREVIEW_BOUNDS = {
	maxPdfMB: { min: 1, max: 100 },
	maxTextMB: { min: 1, max: 20 },
} as const;

/** Vault folder paths, one per line or comma-separated, without surrounding slashes, deduplicated and sorted. */
export function parseFolders(value: string): string[] {
	const folders = value
		.split(/[\n,]/)
		.map((f) => f.trim().replace(/^\/+|\/+$/g, ''))
		.filter((f) => f !== '');
	return [...new Set(folders)].sort();
}

/** Changes one plain setting. Invalid values are rejected without saving. */
export function setFieldOp(key: FieldKey, value: unknown): Op<void> {
	const nonNegative = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
	const within = (v: unknown, b: { min: number; max: number }) => {
		const n = Number(v);
		return Number.isFinite(n) && n >= b.min && n <= b.max ? n : undefined;
	};
	return (draft) => {
		switch (key) {
			case 'proxyUrl': {
				const v = String(value).trim() || undefined;
				if (validateProxyUrl(v)) return { ok: false, error: ['error.proxy-invalid'] };
				draft.network.proxyUrl = v;
				break;
			}
			case 'noProxy':
				draft.network.noProxy = String(value).trim() || undefined;
				break;
			case 'timeoutSeconds': {
				const seconds = nonNegative(Number(value));
				if (!seconds) return { ok: false, error: [] };
				draft.network.timeoutMs = Math.round(seconds * 1000);
				break;
			}
			case 'language': {
				const language: LanguageSetting = value === 'ja' || value === 'en' ? value : 'auto';
				draft.language = language;
				break;
			}
			case 'maxFileMB':
			case 'maxMegapixels':
			case 'cacheMB': {
				const v = nonNegative(Number(value));
				if (v === undefined || (v === 0 && key !== 'cacheMB')) return { ok: false, error: [] };
				draft.preview[key] = v;
				break;
			}
			case 'maxPdfMB':
			case 'maxTextMB': {
				const v = within(value, PREVIEW_BOUNDS[key]);
				if (v === undefined) return { ok: false, error: [] };
				draft.preview[key] = v;
				break;
			}
			case 'defaultConnectionId': {
				const id = String(value);
				// Checked against the latest settings: the connection may have been deleted meanwhile.
				if (id !== '' && !draft.connections.some((c) => c.id === id)) return { ok: false, error: [] };
				draft.upload.defaultConnectionId = id === '' ? undefined : id;
				break;
			}
			case 'webpEnabled':
				draft.upload.webp.enabled = value === true;
				break;
			case 'webpQuality': {
				const v = within(value, UPLOAD_BOUNDS.webpQualityPercent);
				if (v === undefined) return { ok: false, error: [] };
				draft.upload.webp.quality = Math.round(v) / 100;
				break;
			}
			case 'stripPrivate':
				draft.upload.stripPrivate = value === true;
				break;
			case 'uploadMaxFileMB':
			case 'uploadMaxJobMB': {
				const v = within(value, UPLOAD_BOUNDS[key]);
				if (v === undefined) return { ok: false, error: [] };
				draft.upload[key === 'uploadMaxFileMB' ? 'maxFileMB' : 'maxJobMB'] = v;
				break;
			}
			case 'uploadMaxOtherFileMB': {
				const v = within(value, UPLOAD_BOUNDS.uploadMaxOtherFileMB);
				if (v === undefined) return { ok: false, error: [] };
				draft.upload.maxOtherFileMB = v;
				break;
			}
			case 'excludeFolders':
				draft.upload.excludeFolders = parseFolders(String(value));
				break;
			case 'historyLimit': {
				const v = within(value, UPLOAD_BOUNDS.historyLimit);
				if (v === undefined) return { ok: false, error: [] };
				draft.historyLimit = Math.round(v);
				break;
			}
		}
		return { ok: true, value: undefined };
	};
}

/**
 * "Reset and save" for an unreadable data.json. Ordinary settings return to their defaults;
 * the store merges the grow-only records back in, so ledger entries are never lost.
 */
export function resetOp(): Op<void> {
	return (draft) => {
		const defaults = cloneData(DEFAULT_SETTINGS);
		Object.assign(draft, { ...defaults, ...recordsOf(draft), extra: draft.extra });
		return { ok: true, value: undefined };
	};
}

/** I1: records hashes of files about to be sent to private storage. Saved before anything is sent. */
export function addPrivateFilesOp(hashes: readonly string[]): Op<void> {
	return (draft) => {
		// The same hash may come twice (an original sent as is): only invalid values are rejected.
		if (!hashes.every(isSha256Hex)) return { ok: false, error: [] };
		draft.privateFiles = normalizeHashes([...draft.privateFiles, ...hashes]);
		return { ok: true, value: undefined };
	};
}

/** Adds completed uploads to the history. Invalid entries are rejected as a whole. */
export function appendHistoryOp(entries: readonly HistoryEntry[]): Op<void> {
	return (draft) => {
		const merged = mergeHistory(entries);
		if (merged.length !== entries.length) return { ok: false, error: [] };
		draft.history = mergeHistory(draft.history, merged);
		return { ok: true, value: undefined };
	};
}
