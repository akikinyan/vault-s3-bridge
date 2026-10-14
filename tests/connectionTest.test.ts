import type { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AwsCredentialIdentity } from '@smithy/types';
import { describe, expect, it, vi } from 'vitest';
import { runConnectionTest, type ConnectionTestDeps } from '../src/diagnostics/connectionTest';
import type { DiagnosticReport } from '../src/diagnostics/types';
import type { SharedConfig } from '../src/aws/profiles';
import type { StorageConnection } from '../src/settings/types';
import { fail, FakeClient, hangUntilAbort, ok } from './fixtures/fakeClients';
import { nodeError, serviceError, ssoErrors } from './fixtures/sdkErrors';

const connection: StorageConnection = {
	id: 'c1',
	alias: 'work',
	provider: 'aws-s3',
	classification: 'private',
	bucket: 'bucket',
	region: 'ap-northeast-1',
};

const ssoConfig: SharedConfig = {
	configFile: { sso: { sso_session: 's', sso_account_id: '123456789012', sso_role_name: 'Reader' } },
	credentialsFile: {},
};

const creds: AwsCredentialIdentity = {
	accessKeyId: 'ASIAEXAMPLE',
	secretAccessKey: 's',
	sessionToken: 't',
	expiration: new Date('2026-01-01T00:00:00Z'),
};
const ROLE_ARN = 'arn:aws:sts::123456789012:assumed-role/Reader/someone@example.com';
const allBlocked = {
	PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
};

interface Setup {
	config?: SharedConfig;
	resolve?: () => Promise<AwsCredentialIdentity>;
	sts?: ConstructorParameters<typeof FakeClient>[1];
	s3?: ConstructorParameters<typeof FakeClient>[1];
}

function setup(o: Setup = {}) {
	const events: string[] = [];
	const handler = { destroy: vi.fn(() => events.push('handler:destroy')) };
	const sts = new FakeClient('sts', { GetCallerIdentityCommand: ok({ Arn: ROLE_ARN }), ...o.sts }, events);
	const s3 = new FakeClient(
		's3',
		{
			HeadBucketCommand: ok({}),
			GetPublicAccessBlockCommand: ok(allBlocked),
			GetBucketVersioningCommand: ok({}),
			PutObjectCommand: ok({}),
			GetObjectCommand: (input) => ({ Body: { transformToString: async () => `vault-s3-bridge connection test ${String(input.Key)}` } }),
			DeleteObjectCommand: ok({}),
			...o.s3,
		},
		events,
	);
	const deps: ConnectionTestDeps = {
		loadConfig: async () => o.config ?? ssoConfig,
		createRequestHandler: () => handler as unknown as NodeHttpHandler,
		resolveCredentials: vi.fn(o.resolve ?? (async () => creds)),
		createClients: () => ({ sts: sts.asSts(), s3: s3.asS3() }),
		randomId: () => 'fixed-id',
	};
	return { deps, sts, s3, handler, events };
}

const status = (report: DiagnosticReport) => Object.fromEntries(report.items.map((i) => [i.id, `${i.status}${i.code ? `:${i.code}` : ''}`]));
const network = { timeoutMs: 1000 };
const profile = 'sso';

describe('runConnectionTest — authentication gate', () => {
	it('runs every step on success', async () => {
		const { deps, s3 } = setup();
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report)).toEqual({
			profile: 'success',
			credentials: 'success',
			identity: 'success',
			bucket: 'success',
			publicAccessBlock: 'success:all-enabled',
			versioning: 'success:disabled',
			put: 'success',
			get: 'success',
			delete: 'success',
			cleanup: 'success:deleted',
		});
		expect(report.items.find((i) => i.id === 'identity')?.data?.principal).toBe('arn:aws:sts::****:assumed-role/Reader/****');
		expect(s3.calls.find((c) => c.command === 'PutObjectCommand')?.input.Key).toBe('.vault-s3-bridge/connection-test/fixed-id');
	});

	it('rejects a non-SSO profile before resolving credentials or calling AWS', async () => {
		const config: SharedConfig = { configFile: {}, credentialsFile: { sso: { aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE', aws_secret_access_key: 'x' } } };
		const { deps, sts, s3 } = setup({ config });
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report).profile).toBe('fail:static-keys');
		expect(deps.resolveCredentials).not.toHaveBeenCalled();
		expect(sts.calls).toEqual([]);
		expect(s3.calls).toEqual([]);
		expect(report.items.filter((i) => i.status === 'skipped').every((i) => i.code === 'auth-gate')).toBe(true);
	});

	it('offers SSO login only for SSO session problems', async () => {
		const expired = setup({ resolve: () => Promise.reject(ssoErrors.noCache) });
		const r1 = await runConnectionTest(connection, { profile, network, writeTest: false }, expired.deps);
		expect(status(r1).credentials).toBe('fail:sso-login-required');
		expect(r1.ssoLoginCommand).toBe('aws sso login --profile sso');
		expect(expired.s3.calls).toEqual([]);

		const offline = setup({ resolve: () => Promise.reject(ssoErrors.deadProxy) });
		const r2 = await runConnectionTest(connection, { profile, network, writeTest: false }, offline.deps);
		expect(status(r2).credentials).toBe('fail:network');
		expect(r2.ssoLoginCommand).toBeUndefined();
	});

	it('stops before S3 when the resolved credentials are not temporary', async () => {
		const { deps, s3 } = setup({ resolve: async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }) });
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report).identity).toBe('fail:no-session-token');
		expect(s3.calls).toEqual([]);
	});

	it('stops before S3 when the principal is an IAM user', async () => {
		const { deps, s3 } = setup({ sts: { GetCallerIdentityCommand: ok({ Arn: 'arn:aws:iam::123456789012:user/alice' }) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report).identity).toBe('fail:not-assumed-role');
		expect(s3.calls).toEqual([]);
		expect(status(report).put).toBe('skipped:auth-gate');
	});

	it('stops before S3 when GetCallerIdentity fails', async () => {
		const { deps, s3 } = setup({ sts: { GetCallerIdentityCommand: fail(serviceError('AccessDenied', 403)) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(status(report).identity).toBe('fail:access-denied');
		expect(s3.calls).toEqual([]);
	});
});

describe('runConnectionTest — device profile', () => {
	it('fails without calling AWS when no profile is set on this device', async () => {
		const { deps, sts, s3 } = setup();
		const report = await runConnectionTest(connection, { profile: undefined, network, writeTest: true }, deps);
		expect(status(report).profile).toBe('fail:profile-not-set');
		expect(deps.resolveCredentials).not.toHaveBeenCalled();
		expect(sts.calls).toEqual([]);
		expect(s3.calls).toEqual([]);
	});
});

describe('runConnectionTest — S3 diagnostics', () => {
	it('continues after HeadBucket fails, including the write test', async () => {
		const { deps, s3 } = setup({ s3: { HeadBucketCommand: fail(serviceError('Forbidden', 403)) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report).bucket).toBe('fail:access-denied');
		expect(s3.commands()).toEqual(expect.arrayContaining(['GetPublicAccessBlockCommand', 'PutObjectCommand', 'DeleteObjectCommand']));
	});

	it('never reports Block Public Access as safe without permission to read it', async () => {
		const { deps } = setup({ s3: { GetPublicAccessBlockCommand: fail(serviceError('AccessDenied', 403)) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(status(report).publicAccessBlock).toBe('unverified:access-denied');
	});

	it('warns when a private bucket has no Block Public Access configuration', async () => {
		const { deps } = setup({ s3: { GetPublicAccessBlockCommand: fail(serviceError('NoSuchPublicAccessBlockConfiguration', 404)) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(status(report).publicAccessBlock).toBe('warn:not-configured');
	});

	it('warns when a private bucket has some settings disabled', async () => {
		const partial = { PublicAccessBlockConfiguration: { ...allBlocked.PublicAccessBlockConfiguration, BlockPublicPolicy: false } };
		const { deps } = setup({ s3: { GetPublicAccessBlockCommand: ok(partial) } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(status(report).publicAccessBlock).toBe('warn:not-all-enabled');
	});

	it('classifies permission errors on each object operation', async () => {
		const denied = fail(serviceError('AccessDenied', 403));
		const { deps } = setup({ s3: { GetObjectCommand: denied, DeleteObjectCommand: denied } });
		const report = await runConnectionTest(connection, { profile, network, writeTest: true }, deps);
		expect(status(report)).toMatchObject({ get: 'fail:access-denied', delete: 'fail:access-denied', cleanup: 'fail:delete-failed' });
	});

	it('skips the write test unless requested', async () => {
		const { deps, s3 } = setup();
		const report = await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(s3.commands()).not.toContain('PutObjectCommand');
		expect(report.items.map((i) => i.id)).not.toContain('put');
	});

	it('releases clients and the handler after a network failure', async () => {
		const { deps, handler, sts, s3 } = setup({ s3: { HeadBucketCommand: fail(nodeError('ECONNREFUSED')) } });
		await runConnectionTest(connection, { profile, network, writeTest: false }, deps);
		expect(handler.destroy).toHaveBeenCalled();
		expect(sts.destroyed && s3.destroyed).toBe(true);
	});
});

describe('runConnectionTest — cancellation', () => {
	it('can be cancelled while SSO credentials are being resolved', async () => {
		const controller = new AbortController();
		const { deps, sts, s3, handler } = setup({ resolve: () => new Promise<AwsCredentialIdentity>(() => undefined) });
		const pending = runConnectionTest(connection, { profile, network, writeTest: true, signal: controller.signal }, deps);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const report = await pending;
		expect(report.aborted).toBe(true);
		expect(status(report).credentials).toBe('skipped:aborted');
		expect(sts.calls).toEqual([]);
		expect(s3.calls).toEqual([]);
		expect(handler.destroy).toHaveBeenCalled();
	});

	it('cleans up and reports the result when cancelled during the write test, releasing clients afterwards', async () => {
		const controller = new AbortController();
		const { deps, s3, events } = setup({ s3: { PutObjectCommand: hangUntilAbort() } });
		const pending = runConnectionTest(connection, { profile, network, writeTest: true, signal: controller.signal }, deps);
		await vi.waitFor(() => expect(s3.commands()).toContain('PutObjectCommand'));
		controller.abort();
		const report = await pending;
		expect(report.aborted).toBe(true);
		expect(status(report).cleanup).toBe('success:deleted');
		const del = s3.calls.find((c) => c.command === 'DeleteObjectCommand');
		expect(del?.abortedAtSend).toBe(false);
		expect(events.indexOf('s3:DeleteObjectCommand')).toBeLessThan(events.indexOf('s3:destroy'));
		expect(events.indexOf('s3:destroy')).toBeLessThan(events.indexOf('handler:destroy'));
	});

	it('reports a leftover object when cleanup fails after cancellation', async () => {
		const controller = new AbortController();
		const { deps, s3 } = setup({ s3: { PutObjectCommand: hangUntilAbort(), DeleteObjectCommand: fail(nodeError('ETIMEDOUT')) } });
		const pending = runConnectionTest(connection, { profile, network, writeTest: true, signal: controller.signal }, deps);
		await vi.waitFor(() => expect(s3.commands()).toContain('PutObjectCommand'));
		controller.abort();
		const report = await pending;
		const cleanup = report.items.find((i) => i.id === 'cleanup');
		expect(cleanup).toMatchObject({ status: 'warn', code: 'result-unknown', data: { key: '.vault-s3-bridge/connection-test/fixed-id' } });
	});
});
