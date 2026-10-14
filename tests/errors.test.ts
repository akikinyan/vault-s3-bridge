import { describe, expect, it } from 'vitest';
import { classifyError, isIndeterminate } from '../src/aws/errors';
import { nodeError, serviceError, ssoErrors } from './fixtures/sdkErrors';

describe('classifyError', () => {
	it.each([
		['noCache', ssoErrors.noCache],
		['expiredWithoutRefresh', ssoErrors.expiredWithoutRefresh],
		['invalidRefresh', ssoErrors.invalidRefresh],
		['invalidAccessToken', ssoErrors.invalidAccessToken],
	])('suggests SSO login for %s', (_name, error) => {
		expect(classifyError(error).category).toBe('sso-login-required');
	});

	it('does not suggest SSO login for profile configuration problems', () => {
		expect(classifyError(ssoErrors.unknownProfile).category).toBe('profile-config');
		expect(classifyError(ssoErrors.notSsoProfile).category).toBe('profile-config');
	});

	it('does not suggest SSO login for network failures during credential resolution', () => {
		expect(classifyError(ssoErrors.deadProxy).category).toBe('network');
	});

	it('classifies service errors', () => {
		expect(classifyError(serviceError('AccessDenied', 403)).category).toBe('access-denied');
		expect(classifyError(serviceError('Forbidden', 403)).category).toBe('access-denied');
		expect(classifyError(serviceError('NotFound', 404)).category).toBe('not-found');
		expect(classifyError(serviceError('NoSuchBucket', 404)).category).toBe('not-found');
		expect(classifyError(serviceError('InternalError', 500)).category).toBe('unknown');
	});

	it('classifies transport failures', () => {
		expect(classifyError(nodeError('ECONNREFUSED')).category).toBe('network');
		expect(classifyError(nodeError('ETIMEDOUT')).category).toBe('timeout');
		const timeout = new Error('timed out');
		timeout.name = 'TimeoutError';
		expect(classifyError(timeout).category).toBe('timeout');
		const abort = new Error('aborted');
		abort.name = 'AbortError';
		expect(classifyError(abort).category).toBe('aborted');
	});

	it('never puts the message into the code', () => {
		expect(classifyError(ssoErrors.noCache).code).toBe('CredentialsProviderError');
	});

	it('marks transport failures as indeterminate', () => {
		expect(isIndeterminate(classifyError(nodeError('ECONNRESET')))).toBe(true);
		expect(isIndeterminate(classifyError(serviceError('AccessDenied', 403)))).toBe(false);
	});
});
