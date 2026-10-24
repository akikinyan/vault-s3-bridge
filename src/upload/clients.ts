// The S3 client of an upload job, kept free of Obsidian so the smoke test runs the same code from Node.
import type { S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { resolveSsoCredentials } from '../aws/credentials';
import { createRequestHandler } from '../aws/network';
import { loadSharedConfig } from '../aws/profiles';
import { SharedCredentials } from '../preview/credentials';
import { profileOf } from '../settings/device';
import type { SettingsStore } from '../settings/store';
import { CONNECT_TIMEOUT_MS } from '../settings/types';
import { uploadClient } from './s3';

/**
 * The job's own network stack: a handler that lives until the job ends (the preview's handler is rebuilt when
 * network settings change, which would cut a Put in flight) and credentials through the same gate as previews.
 */
export function jobClients(store: Pick<SettingsStore, 'current' | 'device'>, connectionId: string): { client(signal: AbortSignal): Promise<S3Client>; destroy(): void } {
	const network = store.current.network;
	const handler: NodeHttpHandler = createRequestHandler({
		proxyUrl: network.proxyUrl,
		noProxy: network.noProxy,
		connectionTimeoutMs: CONNECT_TIMEOUT_MS,
		requestTimeoutMs: network.timeoutMs,
		// A Put has no total limit (PUT_REQUEST_TIMEOUT_MS): a stalled one ends after this long without data.
		socketTimeoutMs: network.timeoutMs,
	});
	const credentials = new SharedCredentials(
		{
			loadConfig: loadSharedConfig,
			resolve: resolveSsoCredentials,
			callerArn: async (creds, region, h, signal) =>
				(await new STSClient({ region, credentials: creds, requestHandler: h }).send(new GetCallerIdentityCommand({}), { abortSignal: signal })).Arn,
			now: () => Date.now(),
		},
		handler,
	);
	return {
		client: async (signal) => {
			const c = store.current.connections.find((x) => x.id === connectionId);
			const p = profileOf(store.device, connectionId);
			if (!c || !p) throw new Error('no connection or profile');
			const creds = await credentials.get(connectionId, p.generation, p.profile, c.region, signal);
			// Static credentials: nothing is resolved inside send(), after the checkpoint (10-3).
			return uploadClient({ region: c.region, endpoint: c.endpoint, forcePathStyle: c.forcePathStyle, credentials: creds, requestHandler: handler });
		},
		destroy: () => {
			credentials.clear();
			handler.destroy();
		},
	};
}
