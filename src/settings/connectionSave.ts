import type { MessageKey } from '../i18n';
import { stableStringify } from './migrate';
import { checkEditedConnection, checkNewConnection, recordsOf } from './registry';
import type { PluginSettings, StorageConnection } from './types';
import { validateConnectionFields } from './validate';

/**
 * Checks a connection about to be saved against the latest settings, not the ones an editor opened with:
 * a synchronisation may have changed the connection, deleted it, or added ledger entries meanwhile.
 */
export function checkConnectionSave(settings: PluginSettings, previous: StorageConnection | undefined, next: StorageConnection): MessageKey[] {
	const stored = settings.connections.find((c) => c.id === next.id);
	if (previous && !stored) return ['error.connection-deleted'];
	if (previous && stored && stableStringify(stored) !== stableStringify(previous)) return ['error.connection-changed'];
	if (!previous && stored) return ['error.connection-changed'];
	const records = recordsOf(settings);
	const ruleError = previous ? checkEditedConnection(records, previous, next) : checkNewConnection(records, next);
	return [
		...validateConnectionFields(next, settings.connections).map((e) => `error.${e}` as MessageKey),
		...(ruleError ? [`error.${ruleError}` as MessageKey] : []),
	];
}
