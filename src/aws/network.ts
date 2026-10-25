import type { ClientRequest } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { Agent, type AgentConnectOpts } from 'agent-base';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ProxyMode } from '../settings/types';
import { readSystemProxy, type SystemProxy } from './systemProxy';

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

/** How long the system proxy read from the OS is reused, so that a change (VPN, another network) is followed. */
export const SYSTEM_PROXY_TTL_MS = 30_000;

/**
 * Follows the operating system's proxy settings, read again at most every SYSTEM_PROXY_TTL_MS. Hosts in the
 * system's exception list, and in the plugin's own NO_PROXY list, are contacted directly.
 */
export class SystemProxyAgent extends Agent {
	private readonly direct = new HttpsAgent({ keepAlive: true });
	private readonly proxies = new Map<string, HttpsProxyAgent<string>>();
	private cached: { at: number; value: Promise<SystemProxy> } | undefined;

	constructor(
		private readonly read: () => Promise<SystemProxy>,
		private readonly noProxy: string | undefined,
		private readonly now: () => number = () => Date.now(),
	) {
		super({ keepAlive: true });
	}

	private current(): Promise<SystemProxy> {
		const at = this.now();
		if (!this.cached || at - this.cached.at >= SYSTEM_PROXY_TTL_MS) this.cached = { at, value: this.read() };
		return this.cached.value;
	}

	async connect(_req: ClientRequest, opts: AgentConnectOpts): Promise<HttpsAgent | HttpsProxyAgent<string>> {
		const system = await this.current();
		const host = (opts.host ?? '').toLowerCase();
		if (system.kind === 'direct') return this.direct;
		const simple = !host.includes('.') && !host.includes(':');
		if ((system.excludeSimpleHostnames && simple) || matchesNoProxy(host, system.exceptions.join(',')) || matchesNoProxy(host, this.noProxy)) return this.direct;
		let proxy = this.proxies.get(system.url);
		if (!proxy) {
			proxy = new HttpsProxyAgent(system.url, { keepAlive: true });
			this.proxies.set(system.url, proxy);
		}
		return proxy;
	}

	override destroy(): void {
		this.direct.destroy();
		for (const proxy of this.proxies.values()) proxy.destroy();
		super.destroy();
	}
}

export interface RequestHandlerOptions {
	/** Without a mode, the proxy URL is used when one is given. */
	proxyMode?: ProxyMode;
	proxyUrl?: string;
	noProxy?: string;
	/** Reads the operating system's proxy for the 'system' mode (tests replace it). */
	systemProxy?: () => Promise<SystemProxy>;
	connectionTimeoutMs: number;
	/** Until the response starts, sending the body included. */
	requestTimeoutMs: number;
}

/** One handler is shared by the SSO, SSO-OIDC, STS and S3 clients of a single run. */
export function createRequestHandler(options: RequestHandlerOptions): NodeHttpHandler {
	return new NodeHttpHandler({
		httpsAgent: createHttpsAgent(options),
		connectionTimeout: options.connectionTimeoutMs,
		requestTimeout: options.requestTimeoutMs,
		// Without this, @smithy/node-http-handler only logs a warning when requestTimeout passes and keeps waiting.
		throwOnRequestTimeout: true,
	});
}

/** The agent for one proxy mode; undefined connects directly with the handler's own agent. */
export function createHttpsAgent(options: Pick<RequestHandlerOptions, 'proxyMode' | 'proxyUrl' | 'noProxy' | 'systemProxy'>): Agent | undefined {
	const mode = options.proxyMode ?? (options.proxyUrl ? 'url' : 'none');
	if (mode === 'system') return new SystemProxyAgent(options.systemProxy ?? (() => readSystemProxy()), options.noProxy);
	if (mode === 'url' && options.proxyUrl) return new RoutingProxyAgent(options.proxyUrl, (host) => matchesNoProxy(host, options.noProxy));
	return undefined;
}
