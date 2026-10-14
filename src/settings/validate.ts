import { isValidAlias } from '../reference/reference';
import type { StorageConnection } from './types';

export type ValidationError =
	| 'alias-required'
	| 'alias-invalid'
	| 'alias-duplicate'
	| 'bucket-required'
	| 'region-required'
	| 'endpoint-invalid'
	| 'proxy-invalid'
	| 'proxy-credentials-unsupported';

/** Field-level checks. Identity rules (immutability, ledger, aliases) live in registry.ts. */
export function validateConnectionFields(next: StorageConnection, others: readonly StorageConnection[]): ValidationError[] {
	const errors: ValidationError[] = [];
	if (!next.alias) errors.push('alias-required');
	else if (!isValidAlias(next.alias)) errors.push('alias-invalid');
	else if (others.some((c) => c.id !== next.id && c.alias === next.alias)) errors.push('alias-duplicate');
	if (!next.bucket) errors.push('bucket-required');
	if (!next.region) errors.push('region-required');
	if (next.endpoint && !isHttpsUrl(next.endpoint)) errors.push('endpoint-invalid');
	return errors;
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
