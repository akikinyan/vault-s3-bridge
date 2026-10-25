import { Agent as HttpsAgent } from 'node:https';
import type { ClientRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { describe, expect, it } from 'vitest';
import { createHttpsAgent, createRequestHandler, matchesNoProxy, RoutingProxyAgent, SYSTEM_PROXY_TTL_MS, SystemProxyAgent } from '../src/aws/network';
import type { SystemProxy } from '../src/aws/systemProxy';
import { validateProxyUrl } from '../src/settings/validate';

describe('matchesNoProxy', () => {
	it.each([
		['s3.ap-northeast-1.amazonaws.com', 'amazonaws.com', true],
		['s3.ap-northeast-1.amazonaws.com', '.amazonaws.com', true],
		['s3.ap-northeast-1.amazonaws.com', '*.amazonaws.com', true],
		['amazonaws.com', 'amazonaws.com', true],
		['notamazonaws.com', 'amazonaws.com', false],
		['minio.internal:9000', 'minio.internal', true],
		['example.com', 'other.com, example.com', true],
		['example.com', '*', true],
		['example.com', '', false],
		['example.com', undefined, false],
	])('%s with "%s" -> %s', (host, list, expected) => {
		expect(matchesNoProxy(host, list)).toBe(expected);
	});
});

describe('RoutingProxyAgent', () => {
	const agent = new RoutingProxyAgent('http://127.0.0.1:3128', (host) => matchesNoProxy(host, 'internal.example'));
	const req = {} as ClientRequest;

	it('connects directly to NO_PROXY hosts', () => {
		const target = agent.connect(req, { host: 'minio.internal.example', port: 443, secureEndpoint: true });
		expect(target).toBeInstanceOf(HttpsAgent);
		expect(target).not.toBeInstanceOf(HttpsProxyAgent);
	});

	it('uses the proxy for other hosts', () => {
		const target = agent.connect(req, { host: 'oidc.ap-northeast-1.amazonaws.com', port: 443, secureEndpoint: true });
		expect(target).toBeInstanceOf(HttpsProxyAgent);
	});
});

describe('createRequestHandler', () => {
	it('creates a handler with and without a proxy', () => {
		const direct = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 1000 });
		const proxied = createRequestHandler({ proxyUrl: 'http://127.0.0.1:3128', connectionTimeoutMs: 1000, requestTimeoutMs: 1000 });
		direct.destroy();
		proxied.destroy();
	});
});

describe('createHttpsAgent — proxy modes', () => {
	const url = 'http://127.0.0.1:3128';
	const system = (): Promise<SystemProxy> => Promise.resolve({ kind: 'direct', reason: 'not-enabled' });

	it('connects directly without a proxy, and keeps the URL unused', () => {
		expect(createHttpsAgent({ proxyMode: 'none', proxyUrl: url })).toBeUndefined();
		expect(createHttpsAgent({ proxyMode: 'url' })).toBeUndefined();
		expect(createHttpsAgent({})).toBeUndefined();
	});

	it('uses the URL in the url mode, and without a mode when one is given', () => {
		expect(createHttpsAgent({ proxyMode: 'url', proxyUrl: url })).toBeInstanceOf(RoutingProxyAgent);
		expect(createHttpsAgent({ proxyUrl: url })).toBeInstanceOf(RoutingProxyAgent);
	});

	it('follows the system settings in the system mode, whatever the URL', () => {
		const agent = createHttpsAgent({ proxyMode: 'system', proxyUrl: url, systemProxy: system });
		expect(agent).toBeInstanceOf(SystemProxyAgent);
		agent?.destroy();
	});

	it('creates a handler for each mode', () => {
		for (const proxyMode of ['none', 'url', 'system'] as const) createRequestHandler({ proxyMode, proxyUrl: url, systemProxy: system, connectionTimeoutMs: 1000, requestTimeoutMs: 1000 }).destroy();
	});
});

describe('SystemProxyAgent', () => {
	const req = {} as ClientRequest;
	const opts = (host: string) => ({ host, port: 443, secureEndpoint: true });
	const proxy = (over: Partial<Extract<SystemProxy, { kind: 'proxy' }>> = {}): SystemProxy => ({
		kind: 'proxy',
		url: 'http://127.0.0.1:3128',
		exceptions: ['*.local', '169.254/16', 'internal.example'],
		excludeSimpleHostnames: false,
		...over,
	});

	it('uses the system proxy, except for its exceptions and the plugin NO_PROXY list', async () => {
		const agent = new SystemProxyAgent(() => Promise.resolve(proxy()), 'minio.example.org');
		expect(await agent.connect(req, opts('s3.ap-northeast-1.amazonaws.com'))).toBeInstanceOf(HttpsProxyAgent);
		expect(await agent.connect(req, opts('nas.local'))).not.toBeInstanceOf(HttpsProxyAgent);
		expect(await agent.connect(req, opts('minio.internal.example'))).not.toBeInstanceOf(HttpsProxyAgent);
		expect(await agent.connect(req, opts('minio.example.org'))).not.toBeInstanceOf(HttpsProxyAgent);
		// An address range never matches a host name.
		expect(await agent.connect(req, opts('169.254.169.254'))).toBeInstanceOf(HttpsProxyAgent);
		// Simple host names go through the proxy unless the system excludes them.
		expect(await agent.connect(req, opts('intranet'))).toBeInstanceOf(HttpsProxyAgent);
		agent.destroy();
	});

	it('contacts simple host names directly when the system excludes them', async () => {
		const agent = new SystemProxyAgent(() => Promise.resolve(proxy({ excludeSimpleHostnames: true })), undefined);
		expect(await agent.connect(req, opts('intranet'))).toBeInstanceOf(HttpsAgent);
		expect(await agent.connect(req, opts('intranet'))).not.toBeInstanceOf(HttpsProxyAgent);
		expect(await agent.connect(req, opts('s3.amazonaws.com'))).toBeInstanceOf(HttpsProxyAgent);
		agent.destroy();
	});

	it.each(['not-enabled', 'auto-config', 'unsupported-platform', 'unavailable'] as const)('connects directly when the system gives no proxy (%s)', async (reason) => {
		const agent = new SystemProxyAgent(() => Promise.resolve({ kind: 'direct', reason }), undefined);
		const target = await agent.connect(req, opts('s3.amazonaws.com'));
		expect(target).toBeInstanceOf(HttpsAgent);
		expect(target).not.toBeInstanceOf(HttpsProxyAgent);
		agent.destroy();
	});

	it('reads the system settings again once the cache expires, and reuses the agent of a proxy', async () => {
		let now = 0;
		let reads = 0;
		let current: SystemProxy = proxy();
		const agent = new SystemProxyAgent(
			() => {
				reads++;
				return Promise.resolve(current);
			},
			undefined,
			() => now,
		);
		const first = await agent.connect(req, opts('s3.amazonaws.com'));
		now = SYSTEM_PROXY_TTL_MS - 1;
		current = { kind: 'direct', reason: 'not-enabled' };
		expect(await agent.connect(req, opts('s3.amazonaws.com'))).toBe(first);
		expect(reads).toBe(1);
		now = SYSTEM_PROXY_TTL_MS;
		expect(await agent.connect(req, opts('s3.amazonaws.com'))).not.toBeInstanceOf(HttpsProxyAgent);
		expect(reads).toBe(2);
		now = 2 * SYSTEM_PROXY_TTL_MS;
		current = proxy();
		expect(await agent.connect(req, opts('s3.amazonaws.com'))).toBe(first);
		agent.destroy();
	});
});

describe('validateProxyUrl', () => {
	it('accepts http(s) proxies without credentials', () => {
		expect(validateProxyUrl(undefined)).toBeUndefined();
		expect(validateProxyUrl('http://proxy.example.com:8080')).toBeUndefined();
	});

	it('rejects credentials in the URL and invalid URLs', () => {
		expect(validateProxyUrl('http://user:pass@proxy.example.com:8080')).toBe('proxy-credentials-unsupported');
		expect(validateProxyUrl('http://user@proxy.example.com')).toBe('proxy-credentials-unsupported');
		expect(validateProxyUrl('socks5://proxy.example.com')).toBe('proxy-invalid');
		expect(validateProxyUrl('not a url')).toBe('proxy-invalid');
	});
});

describe('createRequestHandler — timeouts', () => {
	const silentServer = async () => {
		const { createServer } = await import('node:http');
		const server = createServer(() => undefined); // accepts, never answers
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		return { server, port: (server.address() as { port: number }).port };
	};
	const request = (port: number) =>
		({ protocol: 'http:', hostname: '127.0.0.1', port, method: 'GET', path: '/', headers: {}, query: {} }) as unknown as Parameters<
			ReturnType<typeof createRequestHandler>['handle']
		>[0];

	it('fails a request the server never answers after requestTimeout, and honours a per-request timeout', async () => {
		const { server, port } = await silentServer();
		try {
			const handler = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 200 });
			let t = Date.now();
			await expect(handler.handle(request(port))).rejects.toMatchObject({ name: 'TimeoutError' });
			expect(Date.now() - t).toBeLessThan(1500);
			t = Date.now();
			await expect(handler.handle(request(port), { requestTimeout: 600 })).rejects.toMatchObject({ name: 'TimeoutError' });
			expect(Date.now() - t).toBeGreaterThanOrEqual(550);
			handler.destroy();
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
	describe('an upload that keeps sending (Step 4: a 100 MB Put was cut after 60 s)', () => {
		/** Reads the whole body, then answers 200. */
		const uploadServer = async () => {
			const { createServer } = await import('node:http');
			const server = createServer((req, res) => {
				let n = 0;
				req.on('data', (c: Buffer) => (n += c.length));
				req.on('end', () => res.writeHead(200, { 'x-received': String(n) }).end());
			});
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			return { server, port: (server.address() as { port: number }).port };
		};
		/** A PUT whose 8 chunks of 1 KB leave over about 1.2 s. */
		const slowPut = async (port: number) => {
			const { Readable } = await import('node:stream');
			let n = 0;
			const body = new Readable({
				read() {
					setTimeout(() => this.push(n++ < 8 ? Buffer.alloc(1024, n) : null), 150);
				},
			});
			return { ...request(port), method: 'PUT', headers: { 'content-length': String(8 * 1024) }, body } as unknown as Parameters<ReturnType<typeof createRequestHandler>['handle']>[0];
		};
		const closing = (server: import('node:http').Server) => {
			server.closeAllConnections();
			server.close();
		};

		it('requestTimeout counts the time spent sending: the library cuts a slow upload', async () => {
			const { server, port } = await uploadServer();
			try {
				const handler = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 300 });
				await expect(handler.handle(await slowPut(port))).rejects.toMatchObject({ name: 'TimeoutError' });
				handler.destroy();
			} finally {
				closing(server);
			}
		});

		it('with requestTimeout off for the request, the upload completes while data flows', async () => {
			const { server, port } = await uploadServer();
			try {
				const handler = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 300 });
				const { response } = await handler.handle(await slowPut(port), { requestTimeout: 0 });
				expect(response.statusCode).toBe(200);
				expect(response.headers['x-received']).toBe(String(8 * 1024));
				handler.destroy();
			} finally {
				closing(server);
			}
		});
	});

	it('does not cut a body that keeps arriving after the headers (a large preview on a slow line)', async () => {
		const { createServer } = await import('node:http');
		const server = createServer((_req, res) => {
			res.writeHead(200, { 'content-type': 'application/octet-stream' });
			let n = 0;
			const timer = setInterval(() => {
				res.write(Buffer.alloc(1024, n));
				if (++n === 8) {
					clearInterval(timer);
					res.end();
				}
			}, 150); // about 1.2 s in total, well past the 300 ms request timeout
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const handler = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 300 });
			const { response } = await handler.handle(request(port));
			const chunks: Buffer[] = [];
			for await (const chunk of response.body as AsyncIterable<Buffer>) chunks.push(chunk);
			expect(Buffer.concat(chunks)).toHaveLength(8 * 1024);
			handler.destroy();
		} finally {
			server.closeAllConnections();
			server.close();
		}
	});
});
