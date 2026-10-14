import type { StorageConnection } from './types';

export type ValidationError =
	| 'alias-required'
	| 'alias-invalid'
	| 'alias-duplicate'
	| 'profile-required'
	| 'bucket-required'
	| 'region-required'
	| 'endpoint-invalid'
	| 'private-to-public-forbidden'
	| 'proxy-invalid'
	| 'proxy-credentials-unsupported';

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Validates a connection about to be saved.
 * `previous` is the stored version of the same connection (undefined when creating).
 */
export function validateConnection(
	next: StorageConnection,
	previous: StorageConnection | undefined,
	others: readonly StorageConnection[],
): ValidationError[] {
	const errors: ValidationError[] = [];
	if (!next.alias) errors.push('alias-required');
	else if (!ALIAS_PATTERN.test(next.alias)) errors.push('alias-invalid');
	else if (others.some((c) => c.id !== next.id && c.alias === next.alias)) errors.push('alias-duplicate');
	if (!next.auth.profile) errors.push('profile-required');
	if (!next.bucket) errors.push('bucket-required');
	if (!next.region) errors.push('region-required');
	if (next.endpoint && !isHttpsUrl(next.endpoint)) errors.push('endpoint-invalid');
	if (previous?.classification === 'private' && next.classification === 'public') {
		errors.push('private-to-public-forbidden');
	}
	return errors;
}

/** True when saving would change where an existing private connection points. */
export function changesPrivateTarget(next: StorageConnection, previous: StorageConnection | undefined): boolean {
	if (!previous || previous.classification !== 'private') return false;
	return (
		previous.bucket !== next.bucket ||
		previous.region !== next.region ||
		(previous.endpoint ?? '') !== (next.endpoint ?? '')
	);
}

export function validateProxyUrl(value: string | undefined): ValidationError | undefined {
	if (!value) return undefined;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'proxy-invalid';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'proxy-invalid';
	if (url.username || url.password) return 'proxy-credentials-unsupported';
	return undefined;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}
