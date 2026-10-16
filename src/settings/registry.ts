// Pure rules for aliases, storage targets and the private-bucket ledger.
// Records are grow-only sets so that synchronisation can never shrink them.
import { isValidAlias } from '../reference/reference';
import { targetKey, type TargetKey } from '../storage/target';
import { normalizeHashes } from './history';
import type { DeepReadonly } from '../util/deepReadonly';
import type { AliasBinding, AliasResolution, Classification, PluginSettings, StorageConnection } from './types';

export interface Records {
	aliasBindings: AliasBinding[];
	aliasResolutions: AliasResolution[];
	privateBuckets: TargetKey[];
	/** SHA-256 of files sent, or about to be sent, to private storage. */
	privateFiles: string[];
}

/** Read-only view accepted by every rule below (settings are exposed read-only by the store). */
export type RecordsView = DeepReadonly<Records>;
type ConnectionView = DeepReadonly<StorageConnection>;

const isStr = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function sortedUnique<T>(items: T[], id: (t: T) => string): T[] {
	const map = new Map<string, T>();
	for (const item of items) map.set(id(item), item);
	return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

const bindingId = (b: AliasBinding) => `${b.alias}\u0000${b.target}\u0000${b.classification}`;

export function normalizeRecords(raw: { aliasBindings?: unknown; aliasResolutions?: unknown; privateBuckets?: unknown; privateFiles?: unknown }): Records {
	const bindings: AliasBinding[] = [];
	for (const b of Array.isArray(raw.aliasBindings) ? raw.aliasBindings : []) {
		if (isRec(b) && isStr(b.alias) && isValidAlias(b.alias) && isStr(b.target) && (b.classification === 'private' || b.classification === 'public')) {
			bindings.push({ alias: b.alias, target: b.target, classification: b.classification });
		}
	}
	const resolutions: AliasResolution[] = [];
	for (const r of Array.isArray(raw.aliasResolutions) ? raw.aliasResolutions : []) {
		if (isRec(r) && isStr(r.id) && isStr(r.alias) && isStr(r.chosen) && Array.isArray(r.knownTargets) && Array.isArray(r.knownResolutions)) {
			resolutions.push({
				id: r.id,
				alias: r.alias,
				chosen: r.chosen,
				knownTargets: r.knownTargets.filter(isStr).sort(),
				knownResolutions: r.knownResolutions.filter(isStr).sort(),
			});
		}
	}
	const buckets = (Array.isArray(raw.privateBuckets) ? raw.privateBuckets : []).filter(isStr);
	return {
		aliasBindings: sortedUnique(bindings, bindingId),
		aliasResolutions: sortedUnique(resolutions, (r) => r.id),
		privateBuckets: sortedUnique(buckets, (b) => b),
		privateFiles: normalizeHashes(raw.privateFiles),
	};
}

/** Union of all given record sets (order-independent, deduplicated, sorted). */
export function mergeRecords(...sets: RecordsView[]): Records {
	return normalizeRecords({
		aliasBindings: sets.flatMap((s) => s.aliasBindings),
		aliasResolutions: sets.flatMap((s) => s.aliasResolutions),
		privateBuckets: sets.flatMap((s) => s.privateBuckets),
		privateFiles: sets.flatMap((s) => s.privateFiles),
	});
}

export function recordsEqual(a: RecordsView, b: RecordsView): boolean {
	return JSON.stringify(normalizeRecords(a)) === JSON.stringify(normalizeRecords(b));
}

export function connectionTarget(c: Pick<ConnectionView, 'bucket' | 'endpoint'>): TargetKey {
	return targetKey(c.bucket, c.endpoint);
}

export type AliasState =
	| { kind: 'unbound' }
	| { kind: 'resolved'; target: TargetKey; classification: Classification }
	| { kind: 'conflict'; candidates: TargetKey[] };

export function resolveAlias(records: RecordsView, alias: string): AliasState {
	const bindings = records.aliasBindings.filter((b) => b.alias === alias);
	const candidates = [...new Set(bindings.map((b) => b.target))].sort();
	const classify = (target: TargetKey): Classification =>
		bindings.some((b) => b.target === target && b.classification === 'private') || records.privateBuckets.includes(target)
			? 'private'
			: 'public';
	if (candidates.length === 0) return { kind: 'unbound' };
	if (candidates.length === 1) return { kind: 'resolved', target: candidates[0]!, classification: classify(candidates[0]!) };
	const resolutions = records.aliasResolutions.filter((r) => r.alias === alias && candidates.includes(r.chosen));
	const covering = resolutions.filter(
		(r) =>
			candidates.every((t) => r.knownTargets.includes(t)) &&
			resolutions.every((other) => other.id === r.id || r.knownResolutions.includes(other.id)),
	);
	if (covering.length === 1) return { kind: 'resolved', target: covering[0]!.chosen, classification: classify(covering[0]!.chosen) };
	return { kind: 'conflict', candidates };
}

export type ConnectionState = 'active' | 'conflict' | 'superseded' | 'blocked';

/**
 * - conflict: the alias has unresolved competing targets
 * - superseded: the alias was resolved to a different target than this connection
 * - blocked: a public connection whose target is in the private ledger
 */
export function connectionState(records: RecordsView, connection: ConnectionView): ConnectionState {
	const target = connectionTarget(connection);
	const alias = resolveAlias(records, connection.alias);
	if (alias.kind === 'conflict') return 'conflict';
	if (alias.kind === 'resolved' && alias.target !== target) return 'superseded';
	if (connection.classification === 'public' && records.privateBuckets.includes(target)) return 'blocked';
	return 'active';
}

/** The connection a reference with this alias may use, if any. */
export function activeConnectionFor(settings: DeepReadonly<PluginSettings>, alias: string): ConnectionView | undefined {
	return settings.connections.find((c) => c.alias === alias && connectionState(settings, c) === 'active');
}

export type RegistryError = 'alias-conflict' | 'alias-bound-elsewhere' | 'private-bucket-public' | 'immutable-field' | 'private-to-public-forbidden';

export function checkNewConnection(records: RecordsView, next: ConnectionView): RegistryError | undefined {
	const target = connectionTarget(next);
	const alias = resolveAlias(records, next.alias);
	if (alias.kind === 'conflict') return 'alias-conflict';
	if (alias.kind === 'resolved' && alias.target !== target) return 'alias-bound-elsewhere';
	if (next.classification === 'public' && records.privateBuckets.includes(target)) return 'private-bucket-public';
	return undefined;
}

export function checkEditedConnection(records: RecordsView, previous: ConnectionView, next: ConnectionView): RegistryError | undefined {
	if (previous.alias !== next.alias || previous.bucket !== next.bucket || (previous.endpoint ?? '') !== (next.endpoint ?? '')) {
		return 'immutable-field';
	}
	if (previous.classification === 'private' && next.classification === 'public') return 'private-to-public-forbidden';
	if (next.classification === 'public' && records.privateBuckets.includes(connectionTarget(next))) return 'private-bucket-public';
	return undefined;
}

/** Adds the binding and, for private connections, the ledger entry. Returns the new records. */
export function recordConnection(records: RecordsView, connection: ConnectionView): Records {
	const target = connectionTarget(connection);
	return mergeRecords(records, {
		aliasBindings: [{ alias: connection.alias, target, classification: connection.classification }],
		aliasResolutions: [],
		privateBuckets: connection.classification === 'private' ? [target] : [],
		privateFiles: [],
	});
}

/** Records the user's choice for a conflicting alias, covering every known candidate and resolution. */
export function resolveConflict(records: RecordsView, alias: string, chosen: TargetKey, id: string): Records {
	const candidates = [...new Set(records.aliasBindings.filter((b) => b.alias === alias).map((b) => b.target))];
	if (!candidates.includes(chosen)) throw new Error('unknown-target');
	const known = records.aliasResolutions.filter((r) => r.alias === alias).map((r) => r.id);
	return mergeRecords(records, {
		aliasBindings: [],
		aliasResolutions: [{ id, alias, chosen, knownTargets: candidates, knownResolutions: known }],
		privateBuckets: [],
		privateFiles: [],
	});
}

export function recordsOf(settings: Pick<DeepReadonly<PluginSettings>, 'aliasBindings' | 'aliasResolutions' | 'privateBuckets' | 'privateFiles'>): Records {
	// Copies, so that the result can be changed without touching the (frozen) source.
	return normalizeRecords({
		aliasBindings: settings.aliasBindings,
		aliasResolutions: settings.aliasResolutions,
		privateBuckets: settings.privateBuckets,
		privateFiles: settings.privateFiles,
	});
}
