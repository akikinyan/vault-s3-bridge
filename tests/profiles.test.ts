import { describe, expect, it } from 'vitest';
import { checkProfile, listProfileNames, listSsoProfileNames, type SharedConfig } from '../src/aws/profiles';

const config: SharedConfig = {
	configFile: {
		sso: { sso_session: 'corp', sso_account_id: '123456789012', sso_role_name: 'Reader', region: 'ap-northeast-1' },
		'legacy-sso': { sso_start_url: 'https://example.awsapps.com/start', sso_region: 'us-east-1', sso_account_id: '123456789012', sso_role_name: 'Reader' },
		'static-in-config': { aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE', aws_secret_access_key: 'x' },
		assume: { role_arn: 'arn:aws:iam::123456789012:role/R', source_profile: 'sso' },
		'env-source': { role_arn: 'arn:aws:iam::123456789012:role/R', credential_source: 'Environment' },
		'source-only': { source_profile: 'sso' },
		process: { credential_process: '/usr/local/bin/helper' },
		web: { web_identity_token_file: '/tmp/token', role_arn: 'arn:aws:iam::123456789012:role/R' },
		'sso-with-process': { sso_session: 'corp', sso_account_id: '123456789012', sso_role_name: 'Reader', credential_process: 'x' },
		incomplete: { sso_session: 'corp' },
		'sso-session.corp': { sso_start_url: 'https://example.awsapps.com/start', sso_region: 'ap-northeast-1' },
	},
	credentialsFile: {
		'static-in-credentials': { aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE', aws_secret_access_key: 'x' },
		// An SSO profile in config whose name also has static keys in the credentials file.
		sso: {},
		'shadowed-sso': { aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE', aws_secret_access_key: 'x' },
	},
};
config.configFile['shadowed-sso'] = { sso_session: 'corp', sso_account_id: '123456789012', sso_role_name: 'Reader' };

describe('checkProfile', () => {
	it('accepts SSO profiles (sso-session and legacy form)', () => {
		expect(checkProfile(config, 'sso')).toEqual({ ok: true });
		expect(checkProfile(config, 'legacy-sso')).toEqual({ ok: true });
	});

	it.each([
		['static-in-config', 'static-keys'],
		['static-in-credentials', 'static-keys'],
		['shadowed-sso', 'static-keys'],
		['assume', 'assume-role-unsupported'],
		['env-source', 'assume-role-unsupported'],
		['source-only', 'assume-role-unsupported'],
		['process', 'credential-process-unsupported'],
		['sso-with-process', 'credential-process-unsupported'],
		['web', 'assume-role-unsupported'],
		['incomplete', 'not-sso'],
		['missing', 'profile-not-found'],
	])('rejects %s as %s', (name, reason) => {
		expect(checkProfile(config, name)).toEqual({ ok: false, reason });
	});
});

describe('profile listing', () => {
	it('excludes sso-session sections', () => {
		expect(listProfileNames(config)).not.toContain('sso-session.corp');
	});

	it('lists only usable SSO profiles', () => {
		expect(listSsoProfileNames(config)).toEqual(['legacy-sso', 'sso']);
	});
});
