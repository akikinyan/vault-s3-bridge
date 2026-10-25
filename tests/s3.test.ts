import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createRequestHandler } from '../src/aws/network';
import { describe, expect, it } from 'vitest';
import { checksumOf, classifyS3Outcome, compareHead, headCommand, PUT_REQUEST_TIMEOUT_MS, putCommand, putWatch, uploadClient } from '../src/upload/s3';

interface Captured {
	method: string;
	path: string;
	headers: Record<string, string>;
	requestTimeout?: number;
}

/** A real S3Client whose HTTP layer is replaced: records each request and answers with a canned response. */
function clientAnswering(...responses: { status: number; headers?: Record<string, string>; body?: string }[]) {
	const captured: Captured[] = [];
	const requestHandler = {
		handle(request: { method: string; path: string; headers: Record<string, string> }, options?: { requestTimeout?: number }) {
			captured.push({ method: request.method, path: request.path, headers: { ...request.headers }, requestTimeout: options?.requestTimeout });
			const r = responses[Math.min(captured.length - 1, responses.length - 1)]!;
			return Promise.resolve({
				response: { statusCode: r.status, headers: r.headers ?? {}, body: Readable.from([Buffer.from(r.body ?? '')]) },
			});
		},
		updateHttpClientConfig: () => undefined,
		httpHandlerConfigs: () => ({}),
		destroy: () => undefined,
	};
	const client = uploadClient({
		region: 'ap-northeast-1',
		credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-token' },
		requestHandler,
	});
	return { client, captured };
}

const BODY = new TextEncoder().encode('example image bytes');
const SENT = createHash('sha256').update(BODY).digest('hex');
const s3Error = (code: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`;

/** Lets the real SDK build the error for a canned response, then classifies it. */
async function putError(status: number, code?: string): Promise<unknown> {
	const { client } = clientAnswering({ status, headers: code ? { 'content-type': 'application/xml' } : {}, body: code ? s3Error(code) : '' });
	return client.send(putCommand('<bucket>', 'k/a.png', BODY, SENT, 'image/png')).then(
		() => {
			throw new Error('expected an error');
		},
		(e: unknown) => e,
	);
}
async function headError(status: number): Promise<unknown> {
	const { client } = clientAnswering({ status });
	return client.send(headCommand('<bucket>', 'k/a.png')).then(
		() => {
			throw new Error('expected an error');
		},
		(e: unknown) => e,
	);
}

describe('request headers (6-1)', () => {
	it('Put: our SHA-256 checksum as sent, if-none-match, no CRC32, content type and length', async () => {
		const { client, captured } = clientAnswering({ status: 200, headers: { etag: '"e"' } });
		await client.send(putCommand('<bucket>', 'k/画像 1.png', BODY, SENT, 'image/png'), { requestTimeout: PUT_REQUEST_TIMEOUT_MS });
		expect(captured).toHaveLength(1);
		const h = captured[0]!.headers;
		expect(captured[0]!.method).toBe('PUT');
		expect(h['x-amz-checksum-sha256']).toBe(Buffer.from(SENT, 'hex').toString('base64'));
		expect(h['x-amz-checksum-sha256']).toBe(checksumOf(SENT));
		expect(h['if-none-match']).toBe('*');
		expect(Object.keys(h).filter((k) => k.startsWith('x-amz-checksum-') && k !== 'x-amz-checksum-sha256')).toEqual([]);
		expect(h['content-type']).toBe('image/png');
		expect(h['content-length']).toBe(String(BODY.byteLength));
		expect(h['x-amz-acl']).toBeUndefined();
		expect(h['x-amz-server-side-encryption']).toBeUndefined();
		expect(Object.keys(h).filter((k) => k.startsWith('x-amz-meta-'))).toEqual([]);
		// The per-request timeout reaches the HTTP handler and overrides its default: 0 turns the total limit off.
		expect(captured[0]!.requestTimeout).toBe(0);
	});

	it('Head asks for the checksum', async () => {
		const { client, captured } = clientAnswering({ status: 200, headers: { 'x-amz-checksum-sha256': checksumOf(SENT), 'x-amz-checksum-type': 'FULL_OBJECT' } });
		const out = await client.send(headCommand('<bucket>', 'k/a.png'));
		expect(captured[0]!.method).toBe('HEAD');
		expect(captured[0]!.headers['x-amz-checksum-mode']).toBe('ENABLED');
		expect(compareHead(out, SENT)).toBe('match');
	});

	it('sends a failing request once (maxAttempts 1)', async () => {
		const { client, captured } = clientAnswering({ status: 503, headers: { 'content-type': 'application/xml' }, body: s3Error('SlowDown') });
		await expect(client.send(putCommand('<bucket>', 'k/a.png', BODY, SENT, 'image/png'))).rejects.toBeDefined();
		expect(captured).toHaveLength(1);
	});

	it('maps formats to content types and rejects a checksum that is not SHA-256 hex', () => {
		// The Content-Type is passed through exactly as given (one of the fixed strings of fileType.ts), never derived.
		expect(putCommand('<bucket>', 'k', BODY, SENT, 'image/jpeg').input.ContentType).toBe('image/jpeg');
		expect(putCommand('<bucket>', 'k', BODY, SENT, 'text/plain; charset=utf-8').input.ContentType).toBe('text/plain; charset=utf-8');
		expect(putCommand('<bucket>', 'k', BODY, SENT, 'application/pdf').input).not.toHaveProperty('ContentDisposition');
		expect(() => checksumOf('abc')).toThrow();
	});
});

describe('compareHead', () => {
	it('matches only the same full-object SHA-256', () => {
		const sum = checksumOf(SENT);
		expect(compareHead({ ChecksumSHA256: sum, ChecksumType: 'FULL_OBJECT' }, SENT)).toBe('match');
		expect(compareHead({ ChecksumSHA256: sum }, SENT)).toBe('match');
		expect(compareHead({ ChecksumSHA256: sum, ChecksumType: 'COMPOSITE' }, SENT)).toBe('mismatch');
		expect(compareHead({ ChecksumSHA256: `${sum}-2` }, SENT)).toBe('mismatch');
		expect(compareHead({}, SENT)).toBe('mismatch'); // no checksum
		expect(compareHead({ ChecksumSHA256: checksumOf('0'.repeat(64)) }, SENT)).toBe('mismatch');
	});
});

describe('classifyS3Outcome (6-2) with errors built by the SDK', () => {
	it.each([
		[412, 'PreconditionFailed', 'precondition'],
		[409, 'ConditionalRequestConflict', 'conflict'],
		[400, 'BadDigest', 'digest'],
		[400, 'InvalidDigest', 'digest'],
		[400, 'XAmzContentSHA256Mismatch', 'digest'],
		[403, 'AccessDenied', 'forbidden'],
		[500, 'InternalError', 'indeterminate'],
		[503, 'SlowDown', 'indeterminate'],
		[400, 'InvalidArgument', 'failed'],
		[404, 'NoSuchBucket', 'failed'],
	])('Put %i %s → %s', async (status, code, outcome) => {
		expect(classifyS3Outcome('put', await putError(status, code), false)).toMatchObject({ outcome, httpStatus: status });
	});

	it.each([
		[404, 'absent'],
		[403, 'head-forbidden'],
		[500, 'indeterminate'],
		[400, 'failed'],
		[412, 'failed'],
	])('Head %i → %s', async (status, outcome) => {
		expect(classifyS3Outcome('head', await headError(status), false)).toMatchObject({ outcome, httpStatus: status });
	});

	it('our own abort: a Put may have been applied, a Head is simply aborted', async () => {
		const e = await putError(412, 'PreconditionFailed');
		expect(classifyS3Outcome('put', e, true).outcome).toBe('indeterminate');
		expect(classifyS3Outcome('head', await headError(404), true).outcome).toBe('aborted');
	});

	it('timeouts and network errors are indeterminate; an unknown Put error too, an unknown Head error fails', () => {
		const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
		const network = Object.assign(new Error('connect'), { code: 'ECONNRESET' });
		expect(classifyS3Outcome('put', timeout, false).outcome).toBe('indeterminate');
		expect(classifyS3Outcome('head', timeout, false).outcome).toBe('indeterminate');
		expect(classifyS3Outcome('put', network, false).outcome).toBe('indeterminate');
		expect(classifyS3Outcome('put', new Error('strange'), false).outcome).toBe('indeterminate');
		expect(classifyS3Outcome('head', new Error('strange'), false).outcome).toBe('failed');
	});
});

describe('compareHead: delivery form (I14 (e), design 3-4)', () => {
	const sum = checksumOf(SENT);
	const expect_ = { contentType: 'application/pdf' };
	it('matches only the exact Content-Type with no Content-Disposition', () => {
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'application/pdf' }, SENT, expect_)).toBe('match');
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'Application/PDF' }, SENT, expect_)).toBe('delivery-mismatch');
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'application/pdf; x=1' }, SENT, expect_)).toBe('delivery-mismatch');
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'text/html' }, SENT, expect_)).toBe('delivery-mismatch');
		expect(compareHead({ ChecksumSHA256: sum }, SENT, expect_)).toBe('delivery-mismatch');
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'application/pdf', ContentDisposition: 'inline' }, SENT, expect_)).toBe('delivery-mismatch');
	});
	it('reports other bytes as a mismatch first, and ignores the type without an expectation', () => {
		expect(compareHead({ ChecksumSHA256: checksumOf('0'.repeat(64)), ContentType: 'text/html' }, SENT, expect_)).toBe('mismatch');
		expect(compareHead({ ChecksumSHA256: sum, ContentType: 'text/html', ContentDisposition: 'attachment' }, SENT)).toBe('match');
	});
});

describe('a Put whose body takes long to send (Step 4: a 100 MB Put was cut)', () => {
	/** An S3-like endpoint that reads the body at about 1 MB/s (or not at all), then answers 200. */
	const endpoint = async (stall = false) => {
		const { createServer } = await import('node:http');
		const { Writable } = await import('node:stream');
		const seen: { headers: Record<string, unknown>; bytes: number; sha256: string }[] = [];
		const server = createServer((req, res) => {
			if (stall) return;
			const hash = createHash('sha256');
			let bytes = 0;
			req.pipe(
				new Writable({
					highWaterMark: 16 * 1024,
					write(chunk: Buffer, _e, cb) {
						hash.update(chunk);
						bytes += chunk.length;
						setTimeout(cb, chunk.length / 1000);
					},
				}),
			).on('finish', () => {
				seen.push({ headers: req.headers, bytes, sha256: hash.digest('hex') });
				res.writeHead(200, { etag: '"e"' }).end();
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		const handler = createRequestHandler({ connectionTimeoutMs: 1000, requestTimeoutMs: 500 });
		const client = uploadClient({
			region: 'ap-northeast-1',
			endpoint: `http://127.0.0.1:${port}`,
			forcePathStyle: true,
			credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'example-secret', sessionToken: 'example-token' },
			requestHandler: handler,
		});
		const close = () => {
			handler.destroy();
			server.closeAllConnections();
			server.close();
		};
		return { client, seen, close };
	};
	const body = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
	const sent = createHash('sha256').update(body).digest('hex');
	const send = (client: ReturnType<typeof uploadClient>, idleMs: number) => {
		const watch = putWatch(idleMs, { set: (run, ms) => setTimeout(run, ms), clear: (t) => clearTimeout(t as NodeJS.Timeout) });
		return client
			.send(putCommand('bucket', 'k/big.bin', body, sent, 'application/octet-stream', watch), { abortSignal: watch.signal, requestTimeout: PUT_REQUEST_TIMEOUT_MS })
			.finally(() => watch.dispose());
	};

	it('is sent whole while it keeps moving, though it takes longer than the idle limit and the request timeout', async () => {
		const e = await endpoint();
		try {
			const t = Date.now();
			await send(e.client, 1000);
			expect(Date.now() - t).toBeGreaterThan(2000);
			expect(e.seen).toHaveLength(1);
			expect(e.seen[0]).toMatchObject({ bytes: body.byteLength, sha256: sent });
			expect(e.seen[0]!.headers).toMatchObject({ 'content-length': String(body.byteLength), 'x-amz-checksum-sha256': checksumOf(sent), 'if-none-match': '*' });
			expect(e.seen[0]!.headers['content-encoding']).toBeUndefined();
		} finally {
			e.close();
		}
	}, 20_000);

	it('is ended when its body stops moving, with an unknown result', async () => {
		const e = await endpoint(true);
		try {
			const t = Date.now();
			const error = await send(e.client, 500).then(
				() => undefined,
				(err: unknown) => err,
			);
			expect(Date.now() - t).toBeLessThan(5000);
			expect(classifyS3Outcome('put', error, false).outcome).toBe('indeterminate');
		} finally {
			e.close();
		}
	}, 20_000);
});
