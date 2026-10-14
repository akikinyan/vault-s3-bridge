import { describe, expect, it } from 'vitest';
import { runWriteTest } from '../src/diagnostics/writeTest';
import type { DiagnosticItem } from '../src/diagnostics/types';
import { fail, FakeClient, hangUntilAbort, ok } from './fixtures/fakeClients';
import { nodeError, serviceError } from './fixtures/sdkErrors';

const KEY = '.vault-s3-bridge/connection-test/abc';
const body = () => `vault-s3-bridge connection test ${KEY}`;
const getOk = () => ({ Body: { transformToString: async () => body() } });

function s3(overrides: Record<string, (input: Record<string, unknown>, signal?: AbortSignal) => unknown> = {}) {
	return new FakeClient('s3', {
		GetBucketVersioningCommand: ok({}),
		PutObjectCommand: ok({}),
		GetObjectCommand: getOk,
		DeleteObjectCommand: ok({}),
		...overrides,
	});
}

const byId = (items: DiagnosticItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));
const run = (client: FakeClient, signal?: AbortSignal) => runWriteTest(client.asS3(), 'bucket', KEY, { signal, cleanupTimeoutMs: 1000 });

describe('runWriteTest', () => {
	it('deletes the object on a bucket without versioning', async () => {
		const client = s3();
		const r = byId(await run(client));
		expect(r.versioning).toMatchObject({ status: 'success', code: 'disabled' });
		expect(r.put?.status).toBe('success');
		expect(r.get?.status).toBe('success');
		expect(r.delete?.status).toBe('success');
		expect(r.cleanup).toMatchObject({ status: 'success', code: 'deleted' });
	});

	it('deletes the exact version when Put returns a VersionId', async () => {
		const client = s3({ GetBucketVersioningCommand: ok({ Status: 'Enabled' }), PutObjectCommand: ok({ VersionId: 'v1' }) });
		const r = byId(await run(client));
		expect(client.calls.find((c) => c.command === 'DeleteObjectCommand')?.input.VersionId).toBe('v1');
		expect(r.cleanup).toMatchObject({ status: 'success', code: 'deleted' });
	});

	it('warns that only a delete marker may exist when versioning is enabled without a VersionId', async () => {
		const r = byId(await run(s3({ GetBucketVersioningCommand: ok({ Status: 'Enabled' }) })));
		expect(r.cleanup).toMatchObject({ status: 'warn', code: 'delete-marker-only', data: { key: KEY } });
	});

	it('treats versioning AccessDenied as unverified and does not claim a clean delete', async () => {
		const r = byId(await run(s3({ GetBucketVersioningCommand: fail(serviceError('AccessDenied', 403)) })));
		expect(r.versioning).toMatchObject({ status: 'unverified', code: 'access-denied' });
		expect(r.cleanup).toMatchObject({ status: 'warn', code: 'delete-marker-only' });
	});

	it('still deletes when Get fails', async () => {
		const client = s3({ GetObjectCommand: fail(serviceError('AccessDenied', 403)) });
		const r = byId(await run(client));
		expect(r.get).toMatchObject({ status: 'fail', code: 'access-denied' });
		expect(client.commands()).toContain('DeleteObjectCommand');
		expect(r.cleanup?.code).toBe('deleted');
	});

	it('reports content mismatch', async () => {
		const r = byId(await run(s3({ GetObjectCommand: () => ({ Body: { transformToString: async () => 'other' } }) })));
		expect(r.get).toMatchObject({ status: 'fail', code: 'content-mismatch' });
	});

	it('reports the remaining key when Delete is denied', async () => {
		const r = byId(await run(s3({ PutObjectCommand: ok({ VersionId: 'v9' }), DeleteObjectCommand: fail(serviceError('AccessDenied', 403)) })));
		expect(r.delete).toMatchObject({ status: 'fail', code: 'access-denied' });
		expect(r.cleanup).toMatchObject({ status: 'fail', code: 'delete-failed', data: { key: KEY, versionId: 'v9' } });
	});

	it('reports an unknown result when Delete times out', async () => {
		const r = byId(await run(s3({ DeleteObjectCommand: fail(nodeError('ETIMEDOUT')) })));
		expect(r.cleanup).toMatchObject({ status: 'warn', code: 'result-unknown', data: { key: KEY } });
	});

	it('does not delete when Put was definitely rejected', async () => {
		const client = s3({ PutObjectCommand: fail(serviceError('AccessDenied', 403)) });
		const r = byId(await run(client));
		expect(client.commands()).not.toContain('DeleteObjectCommand');
		expect(r.cleanup).toMatchObject({ status: 'success', code: 'not-created' });
	});

	it('still deletes when the Put result is unknown', async () => {
		const client = s3({ PutObjectCommand: fail(nodeError('ECONNRESET')) });
		const r = byId(await run(client));
		expect(r.put).toMatchObject({ status: 'fail', code: 'network' });
		expect(client.commands()).toContain('DeleteObjectCommand');
		expect(r.cleanup?.code).toBe('deleted');
	});

	it('cleans up with its own signal after the user cancels during Put', async () => {
		const controller = new AbortController();
		const client = s3({ PutObjectCommand: hangUntilAbort() });
		const pending = run(client, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		const r = byId(await pending);
		expect(r.put).toMatchObject({ status: 'skipped', code: 'aborted' });
		const del = client.calls.find((c) => c.command === 'DeleteObjectCommand');
		expect(del).toBeDefined();
		expect(del?.signal).not.toBe(controller.signal);
		expect(del?.abortedAtSend).toBe(false);
		expect(r.cleanup?.code).toBe('deleted');
	});

	it('creates nothing when cancelled before Put', async () => {
		const controller = new AbortController();
		controller.abort();
		const client = s3();
		const r = byId(await run(client, controller.signal));
		expect(client.commands()).toEqual([]);
		expect(r.cleanup).toMatchObject({ status: 'success', code: 'not-created' });
	});
});
