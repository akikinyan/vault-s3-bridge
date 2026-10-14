import { GetPublicAccessBlockCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@smithy/types';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { checkResolvedCredentials, resolveSsoCredentials } from '../aws/credentials';
import { classifyError } from '../aws/errors';
import { createRequestHandler, type RequestHandlerOptions } from '../aws/network';
import { checkProfile, loadSharedConfig, type SharedConfig } from '../aws/profiles';
import { redactArn } from '../util/redact';
import { CLEANUP_TIMEOUT_MS, CONNECT_TIMEOUT_MS, type NetworkSettings, type StorageConnection } from '../settings/types';
import { raceAbort, type DiagnosticItem, type DiagnosticReport } from './types';
import { runWriteTest, TEST_PREFIX } from './writeTest';

export interface ConnectionTestDeps {
	loadConfig(): Promise<SharedConfig>;
	createRequestHandler(options: RequestHandlerOptions): NodeHttpHandler;
	resolveCredentials(profile: string, handler: NodeHttpHandler): Promise<AwsCredentialIdentity>;
	createClients(connection: StorageConnection, credentials: AwsCredentialIdentity, handler: NodeHttpHandler): { sts: STSClient; s3: S3Client };
	randomId(): string;
}

export const defaultDeps: ConnectionTestDeps = {
	loadConfig: loadSharedConfig,
	createRequestHandler,
	resolveCredentials: resolveSsoCredentials,
	createClients(connection, credentials, requestHandler) {
		const common = { region: connection.region, credentials, requestHandler };
		return {
			sts: new STSClient(common),
			s3: new S3Client({ ...common, endpoint: connection.endpoint, forcePathStyle: connection.forcePathStyle }),
		};
	},
	randomId: () => crypto.randomUUID(),
};

export interface ConnectionTestOptions {
	/** The AWS profile configured for this connection on this device. */
	profile: string | undefined;
	network: NetworkSettings;
	writeTest: boolean;
	signal?: AbortSignal;
	cleanupTimeoutMs?: number;
	/** Called after each step with the items collected so far. */
	onProgress?(items: readonly DiagnosticItem[]): void;
}

const S3_STEPS = ['bucket', 'publicAccessBlock'] as const;
const WRITE_STEPS = ['versioning', 'put', 'get', 'delete', 'cleanup'] as const;

/**
 * Runs the connection diagnostics.
 * Steps 1-3 form an authentication gate: if any of them fails, no S3 request is made.
 * S3 steps are judged independently of each other.
 */
export async function runConnectionTest(
	connection: StorageConnection,
	options: ConnectionTestOptions,
	deps: ConnectionTestDeps = defaultDeps,
): Promise<DiagnosticReport> {
	const items: DiagnosticItem[] = [];
	const report: DiagnosticReport = { items, aborted: false };
	const { signal } = options;
	const push = (item: DiagnosticItem) => {
		items.push(item);
		options.onProgress?.(items);
	};
	const skipRest = (code: string) => {
		const done = new Set(items.map((i) => i.id));
		const rest = ['profile', 'credentials', 'identity', ...S3_STEPS, ...(options.writeTest ? WRITE_STEPS : [])] as const;
		for (const id of rest) if (!done.has(id)) push({ id, status: 'skipped', code });
	};
	const finishAborted = () => {
		report.aborted = true;
		skipRest('aborted');
		return report;
	};
	const profile = options.profile;

	// 1. Profile configuration (before any credential is resolved).
	if (!profile) {
		push({ id: 'profile', status: 'fail', code: 'profile-not-set' });
		skipRest('auth-gate');
		return report;
	}
	try {
		const check = checkProfile(await deps.loadConfig(), profile);
		if (!check.ok) {
			push({ id: 'profile', status: 'fail', code: check.reason });
			skipRest('auth-gate');
			return report;
		}
		push({ id: 'profile', status: 'success' });
	} catch (error) {
		push({ id: 'profile', status: 'fail', code: classifyError(error).category });
		skipRest('auth-gate');
		return report;
	}
	if (signal?.aborted) return finishAborted();

	const handler = deps.createRequestHandler({
		proxyUrl: options.network.proxyUrl,
		noProxy: options.network.noProxy,
		connectionTimeoutMs: CONNECT_TIMEOUT_MS,
		requestTimeoutMs: options.network.timeoutMs,
	});
	let clients: { sts: STSClient; s3: S3Client } | undefined;
	try {
		// 2. SSO credentials. fromSSO cannot be cancelled, so cancellation races it.
		let credentials: AwsCredentialIdentity;
		try {
			credentials = await raceAbort(deps.resolveCredentials(profile, handler), signal);
		} catch (error) {
			const c = classifyError(error);
			if (c.category === 'aborted') return finishAborted();
			if (c.category === 'sso-login-required') report.ssoLoginCommand = `aws sso login --profile ${profile}`;
			push({ id: 'credentials', status: 'fail', code: c.category });
			skipRest('auth-gate');
			return report;
		}
		push({
			id: 'credentials',
			status: 'success',
			data: credentials.expiration ? { expiration: credentials.expiration.toISOString() } : undefined,
		});

		// 3. Verify what was resolved.
		clients = deps.createClients(connection, credentials, handler);
		try {
			const identity = await clients.sts.send(new GetCallerIdentityCommand({}), { abortSignal: signal });
			const check = checkResolvedCredentials(credentials, identity.Arn);
			const principal = redactArn(identity.Arn ?? '');
			if (!check.ok) {
				push({ id: 'identity', status: 'fail', code: check.reason, data: { principal } });
				skipRest('auth-gate');
				return report;
			}
			push({ id: 'identity', status: 'success', data: { principal } });
		} catch (error) {
			const c = classifyError(error);
			if (c.category === 'aborted') return finishAborted();
			push({ id: 'identity', status: 'fail', code: c.category });
			skipRest('auth-gate');
			return report;
		}

		// 4. Bucket reachability (s3:ListBucket). Does not prove object permissions.
		if (signal?.aborted) return finishAborted();
		try {
			await clients.s3.send(new HeadBucketCommand({ Bucket: connection.bucket }), { abortSignal: signal });
			push({ id: 'bucket', status: 'success' });
		} catch (error) {
			const c = classifyError(error);
			if (c.category === 'aborted') return finishAborted();
			push({ id: 'bucket', status: 'fail', code: c.category });
		}

		// 5. Block Public Access. Lack of permission is "unverified", never "safe".
		if (signal?.aborted) return finishAborted();
		try {
			const r = await clients.s3.send(new GetPublicAccessBlockCommand({ Bucket: connection.bucket }), { abortSignal: signal });
			const c = r.PublicAccessBlockConfiguration;
			const all = !!(c?.BlockPublicAcls && c.IgnorePublicAcls && c.BlockPublicPolicy && c.RestrictPublicBuckets);
			if (all) push({ id: 'publicAccessBlock', status: 'success', code: 'all-enabled' });
			else push({ id: 'publicAccessBlock', status: connection.classification === 'private' ? 'warn' : 'success', code: 'not-all-enabled' });
		} catch (error) {
			const c = classifyError(error);
			if (c.category === 'aborted') return finishAborted();
			if ((error as { name?: string }).name === 'NoSuchPublicAccessBlockConfiguration') {
				push({ id: 'publicAccessBlock', status: connection.classification === 'private' ? 'warn' : 'success', code: 'not-configured' });
			} else {
				push({ id: 'publicAccessBlock', status: 'unverified', code: c.category });
			}
		}

		// 6. Optional write test (runs regardless of the HeadBucket result).
		if (options.writeTest) {
			const key = `${TEST_PREFIX}${deps.randomId()}`;
			const writeItems = await runWriteTest(clients.s3, connection.bucket, key, {
				signal,
				cleanupTimeoutMs: options.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS,
			});
			for (const item of writeItems) push(item);
			if (signal?.aborted) report.aborted = true;
		}
		return report;
	} finally {
		// Release only after cleanup has finished.
		clients?.sts.destroy();
		clients?.s3.destroy();
		handler.destroy();
	}
}
