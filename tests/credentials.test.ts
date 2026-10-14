import { describe, expect, it, vi } from 'vitest';
import { checkResolvedCredentials, principalTypeOf, resolveSsoCredentials } from '../src/aws/credentials';
import { defaultProvider, DefaultCredentialChainDisabledError } from '../src/aws/noDefaultCredentials';
import type { NodeHttpHandler } from '@smithy/node-http-handler';

const fromSSO = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/credential-provider-sso', () => ({ fromSSO }));

const temp = { accessKeyId: 'ASIAEXAMPLE', secretAccessKey: 's', sessionToken: 't' };

describe('checkResolvedCredentials', () => {
	it('accepts temporary credentials of an assumed role', () => {
		expect(checkResolvedCredentials(temp, 'arn:aws:sts::123456789012:assumed-role/Reader/someone')).toEqual({
			ok: true,
			principalType: 'assumed-role',
		});
	});

	it('rejects credentials without a session token', () => {
		const result = checkResolvedCredentials({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }, 'arn:aws:sts::123456789012:assumed-role/R/x');
		expect(result).toEqual({ ok: false, reason: 'no-session-token' });
	});

	it('rejects IAM user principals even with a session token (GetSessionToken)', () => {
		expect(checkResolvedCredentials(temp, 'arn:aws:iam::123456789012:user/alice')).toEqual({ ok: false, reason: 'not-assumed-role' });
		expect(checkResolvedCredentials(temp, 'arn:aws:sts::123456789012:federated-user/alice')).toEqual({ ok: false, reason: 'not-assumed-role' });
		expect(checkResolvedCredentials(temp, undefined)).toEqual({ ok: false, reason: 'not-assumed-role' });
	});

	it('extracts principal types', () => {
		expect(principalTypeOf('arn:aws:sts::123456789012:assumed-role/R/s')).toBe('assumed-role');
		expect(principalTypeOf('garbage')).toBe('unknown');
	});
});

describe('resolveSsoCredentials', () => {
	it('uses fromSSO only and forwards the shared request handler', async () => {
		const provider = vi.fn().mockResolvedValue(temp);
		fromSSO.mockReturnValue(provider);
		const handler = { tag: 'shared' } as unknown as NodeHttpHandler;
		await expect(resolveSsoCredentials('p', handler)).resolves.toBe(temp);
		expect(fromSSO).toHaveBeenCalledWith({ profile: 'p', clientConfig: { requestHandler: handler } });
	});
});

describe('default credential chain stub', () => {
	it('does not throw when the SDK builds its config, only when invoked', async () => {
		const provider = defaultProvider();
		await expect(provider()).rejects.toBeInstanceOf(DefaultCredentialChainDisabledError);
	});
});
