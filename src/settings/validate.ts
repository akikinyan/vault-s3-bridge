import { isValidAlias } from '../reference/reference';
import type { MessageKey } from '../i18n';
import { checkTemplate, identifyingVariables } from '../upload/key';
import type { StorageConnection } from './types';

export type ValidationError =
	| 'alias-required'
	| 'alias-invalid'
	| 'alias-duplicate'
	| 'bucket-required'
	| 'region-required'
	| 'endpoint-invalid'
	| 'template-invalid'
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
	if (checkTemplate(next.keyTemplate)) errors.push('template-invalid');
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

/**
 * A public base URL is joined with an encoded key exactly once (9-3): https only, no user information, query or
 * fragment, and a path of [A-Za-z0-9-_.~/%] only.
 */
export function validatePublicBaseUrl(value: string): 'public-url-invalid' | undefined {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return 'public-url-invalid';
	}
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return 'public-url-invalid';
	if (value.includes('?') || value.includes('#')) return 'public-url-invalid';
	// Check the path as written: the URL parser would percent-encode other characters and hide them.
	const rawPath = value.replace(/^https:\/\/[^/]*/i, '');
	if (!/^[A-Za-z0-9\-_.~/%]*$/.test(rawPath)) return 'public-url-invalid';
	return undefined;
}

function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === 'https:';
	} catch {
		return false;
	}
}

/**
 * Shown in the connection editor and the settings list; saving is not blocked by these (11-3, plan 2-8): an
 * invalid template is a save error instead (validateConnectionFields).
 */
export function connectionWarnings(c: Pick<StorageConnection, 'classification' | 'publicBaseUrl' | 'keyTemplate'>): { key: MessageKey; params?: Record<string, string> }[] {
	const out: { key: MessageKey; params?: Record<string, string> }[] = [];
	const template = checkTemplate(c.keyTemplate);
	if (template) out.push({ key: template.reason === 'unknown-variable' ? 'edit.templateUnknown' : 'edit.templateInvalid', params: { name: 'name' in template ? template.name : '' } });
	if (c.classification !== 'public') return out;
	if (c.publicBaseUrl === undefined || validatePublicBaseUrl(c.publicBaseUrl)) out.push({ key: 'edit.publicBaseUrlNeeded' });
	const vars = identifyingVariables(c.keyTemplate);
	if (vars.length > 0) out.push({ key: 'upload.confirm.identifying', params: { vars: vars.map((v) => `{${v}}`).join(' ') } });
	return out;
}
