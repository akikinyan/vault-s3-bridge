import type { ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { HttpsProxyAgent } from 'https-proxy-agent';

/** Returns true when `host` must be contacted directly according to a NO_PROXY list. */
export function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
	if (!noProxy) return false;
	const target = host.toLowerCase().replace(/:\d+$/, '');
	return noProxy
		.split(/[\s,]+/)
		.map((entry) => entry.trim().toLowerCase().replace(/:\d+$/, ''))
		.filter((entry) => entry !== '')
		.some((entry) => {
			if (entry === '*') return true;
			const bare = entry.startsWith('*.') ? entry.slice(2) : entry.startsWith('.') ? entry.slice(1) : entry;
			return target === bare || target.endsWith(`.${bare}`);
		});
}

/**
 * Routes each connection either through the proxy or directly (hosts listed in NO_PROXY).
 * agent-base accepts an Agent returned from connect() and delegates the request to it.
 */
export class RoutingProxyAgent extends Agent {
	private readonly proxy: HttpsProxyAgent<string>;
	private readonly direct = new HttpsAgent({ keepAlive: true });

	constructor(
		proxyUrl: string,
		private readonly bypass: (host: string) => boolean,
	) {
		super({ keepAlive: true });
		this.proxy = new HttpsProxyAgent(proxyUrl, { keepAlive: true });
	}

	connect(_req: ClientRequest, opts: AgentConnectOpts): HttpsAgent | HttpsProxyAgent<string> {
		return this.bypass(opts.host ?? '') ? this.direct : this.proxy;
	}

	override destroy(): void {
		this.direct.destroy();
		this.proxy.destroy();
		super.destroy();
	}
}

export interface RequestHandlerOptions {
	proxyUrl?: string;
	noProxy?: string;
	connectionTimeoutMs: number;
	/** Until the response starts, sending the body included. */
	requestTimeoutMs: number;
}

/** One handler is shared by the SSO, SSO-OIDC, STS and S3 clients of a single run. */
export function createRequestHandler(options: RequestHandlerOptions): NodeHttpHandler {
	const httpsAgent = options.proxyUrl
		? new RoutingProxyAgent(options.proxyUrl, (host) => matchesNoProxy(host, options.noProxy))
		: undefined;
	return new NodeHttpHandler({
		httpsAgent,
		connectionTimeout: options.connectionTimeoutMs,
		requestTimeout: options.requestTimeoutMs,
		// Without this, @smithy/node-http-handler only logs a warning when requestTimeout passes and keeps waiting.
		throwOnRequestTimeout: true,
	});
}
