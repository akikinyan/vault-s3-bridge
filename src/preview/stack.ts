import { S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { resolveSsoCredentials } from '../aws/credentials';
import { createRequestHandler } from '../aws/network';
import { loadSharedConfig } from '../aws/profiles';
import type { DeviceState } from '../settings/device';
import { CONNECT_TIMEOUT_MS, type PluginSettings } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';
import { SharedCredentials } from './credentials';
import { PreviewService } from './service';

/** Builds the preview service with real AWS clients. Used by the plugin and by the local smoke script. */
export function createPreviewStack(settings: () => DeepReadonly<PluginSettings>, device: () => DeepReadonly<DeviceState>): { service: PreviewService; handler: NodeHttpHandler } {
	const network = settings().network;
	const handler = createRequestHandler({
		proxyUrl: network.proxyUrl,
		noProxy: network.noProxy,
		connectionTimeoutMs: CONNECT_TIMEOUT_MS,
		requestTimeoutMs: network.timeoutMs,
	});
	const credentials = new SharedCredentials(
		{
			loadConfig: loadSharedConfig,
			resolve: resolveSsoCredentials,
			// Clients share the handler and are not destroyed individually (destroy() would close the handler).
			callerArn: async (creds, region, h, signal) =>
				(await new STSClient({ region, credentials: creds, requestHandler: h }).send(new GetCallerIdentityCommand({}), { abortSignal: signal })).Arn,
			now: () => Date.now(),
		},
		handler,
	);
	const service = new PreviewService({
		settings,
		device,
		credentials,
		s3For: (connection, creds) =>
			new S3Client({
				region: connection.region,
				endpoint: connection.endpoint,
				forcePathStyle: connection.forcePathStyle,
				credentials: creds,
				requestHandler: handler,
			}),
		createObjectURL: (blob) => URL.createObjectURL(blob),
		revokeObjectURL: (url) => URL.revokeObjectURL(url),
		now: () => Date.now(),
	});
	return { service, handler };
}
