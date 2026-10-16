// Operations passed to SettingsStore.mutate. Each one validates against the latest merged settings
// it receives, so a synchronisation that happened while a dialog was open is taken into account.
import { setProfile } from './device';
import { checkConnectionSave } from './connectionSave';
import { recordConnection, recordsOf, resolveConflict } from './registry';
import type { Op } from './store';
import { DEFAULT_SETTINGS, type LanguageSetting, type StorageConnection } from './types';
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

export type FieldKey = 'proxyUrl' | 'noProxy' | 'timeoutSeconds' | 'language' | 'maxFileMB' | 'maxMegapixels' | 'cacheMB';

/** Changes one plain setting. Invalid values are rejected without saving. */
export function setFieldOp(key: FieldKey, value: unknown): Op<void> {
	const nonNegative = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
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
