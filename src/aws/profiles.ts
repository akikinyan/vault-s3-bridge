import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';

type Section = Record<string, string | undefined>;
export interface SharedConfig {
	configFile: Record<string, Section>;
	credentialsFile: Record<string, Section>;
}

export type ProfileRejection =
	| 'profile-not-found'
	| 'static-keys'
	| 'assume-role-unsupported'
	| 'credential-process-unsupported'
	| 'web-identity-unsupported'
	| 'not-sso';

export type ProfileCheck = { ok: true } | { ok: false; reason: ProfileRejection };

// Sections such as `[sso-session x]` and `[services x]` are parsed as "<type>.<name>".
const NON_PROFILE_PREFIXES = ['sso-session.', 'services.'];

export async function loadSharedConfig(): Promise<SharedConfig> {
	return loadSharedConfigFiles({ ignoreCache: true });
}

export function listProfileNames(config: SharedConfig): string[] {
	const names = new Set<string>();
	for (const name of Object.keys(config.configFile)) {
		if (!NON_PROFILE_PREFIXES.some((p) => name.startsWith(p))) names.add(name);
	}
	for (const name of Object.keys(config.credentialsFile)) names.add(name);
	return [...names].sort();
}

/** Lists profiles that pass {@link checkProfile}; used to populate the settings dropdown. */
export function listSsoProfileNames(config: SharedConfig): string[] {
	return listProfileNames(config).filter((name) => checkProfile(config, name).ok);
}

/**
 * Verifies, before any credential is resolved, that the profile uses IAM Identity Center (SSO)
 * and nothing else. Any other credential source is rejected.
 */
export function checkProfile(config: SharedConfig, name: string): ProfileCheck {
	const profile = config.configFile[name];
	const credentials = config.credentialsFile[name];
	if (!profile && !credentials) return { ok: false, reason: 'profile-not-found' };
	const merged: Section = { ...(credentials ?? {}), ...(profile ?? {}) };
	const has = (key: string) => typeof merged[key] === 'string' && merged[key] !== '';

	if (has('aws_access_key_id') || has('aws_secret_access_key') || has('aws_session_token')) {
		return { ok: false, reason: 'static-keys' };
	}
	if (has('role_arn') || has('source_profile') || has('credential_source')) {
		return { ok: false, reason: 'assume-role-unsupported' };
	}
	if (has('credential_process')) return { ok: false, reason: 'credential-process-unsupported' };
	if (has('web_identity_token_file')) return { ok: false, reason: 'web-identity-unsupported' };

	const hasSsoSource = has('sso_session') || has('sso_start_url');
	if (!hasSsoSource || !has('sso_account_id') || !has('sso_role_name')) {
		return { ok: false, reason: 'not-sso' };
	}
	return { ok: true };
}
