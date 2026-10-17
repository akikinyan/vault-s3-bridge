import { Agent as HttpsAgent } from 'node:https';
import type { ClientRequest } from 'node:http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { describe, expect, it } from 'vitest';
import { createRequestHandler, matchesNoProxy, RoutingProxyAgent } from '../src/aws/network';
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
});
