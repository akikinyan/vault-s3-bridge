import {
	DeleteObjectCommand,
	GetBucketVersioningCommand,
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from '@aws-sdk/client-s3';
import { classifyError, isIndeterminate } from '../aws/errors';
import type { DiagnosticItem } from './types';

export const TEST_PREFIX = '.vault-s3-bridge/connection-test/';

export interface WriteTestOptions {
	/** User cancellation. Never used for cleanup. */
	signal?: AbortSignal;
	cleanupTimeoutMs: number;
}

type VersioningState = 'enabled' | 'suspended' | 'disabled' | 'unknown';
type PutOutcome = { kind: 'ok'; versionId?: string } | { kind: 'failed' } | { kind: 'indeterminate' } | { kind: 'not-attempted' };

/**
 * Put → Get → Delete of a unique object under {@link TEST_PREFIX}.
 * Cleanup always runs once a Put was attempted, using its own timeout instead of the user's signal,
 * and its result is reported as deleted / delete-marker-only / delete-failed / result-unknown.
 */
export async function runWriteTest(s3: S3Client, bucket: string, key: string, options: WriteTestOptions): Promise<DiagnosticItem[]> {
	const { signal } = options;
	const items: DiagnosticItem[] = [];
	const aborted = () => signal?.aborted === true;

	// Versioning (reference information; requires s3:GetBucketVersioning).
	let versioning: VersioningState = 'unknown';
	if (aborted()) {
		items.push({ id: 'versioning', status: 'skipped', code: 'aborted' });
	} else {
		try {
			const r = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }), { abortSignal: signal });
			versioning = r.Status === 'Enabled' ? 'enabled' : r.Status === 'Suspended' ? 'suspended' : 'disabled';
			items.push({ id: 'versioning', status: 'success', code: versioning });
		} catch (error) {
			items.push({ id: 'versioning', status: 'unverified', code: classifyError(error).category });
		}
	}

	// Put
	const body = `vault-s3-bridge connection test ${key}`;
	let put: PutOutcome = { kind: 'not-attempted' };
	if (aborted()) {
		items.push({ id: 'put', status: 'skipped', code: 'aborted' });
	} else {
		try {
			const r = await s3.send(
				new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'text/plain' }),
				{ abortSignal: signal },
			);
			put = { kind: 'ok', versionId: r.VersionId };
			items.push({ id: 'put', status: 'success' });
		} catch (error) {
			const c = classifyError(error);
			put = isIndeterminate(c) ? { kind: 'indeterminate' } : { kind: 'failed' };
			items.push({ id: 'put', status: c.category === 'aborted' ? 'skipped' : 'fail', code: c.category });
		}
	}

	// Get
	if (put.kind !== 'ok') {
		items.push({ id: 'get', status: 'skipped' });
	} else if (aborted()) {
		items.push({ id: 'get', status: 'skipped', code: 'aborted' });
	} else {
		try {
			const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
			const text = await r.Body?.transformToString();
			items.push(text === body ? { id: 'get', status: 'success' } : { id: 'get', status: 'fail', code: 'content-mismatch' });
		} catch (error) {
			const c = classifyError(error);
			items.push({ id: 'get', status: c.category === 'aborted' ? 'skipped' : 'fail', code: c.category });
		}
	}

	// Delete and cleanup (independent of the user's signal).
	if (put.kind === 'not-attempted' || put.kind === 'failed') {
		items.push({ id: 'delete', status: 'skipped' });
		items.push({ id: 'cleanup', status: 'success', code: 'not-created' });
		return items;
	}
	const versionId = put.kind === 'ok' ? put.versionId : undefined;
	const leftover: Record<string, string> = versionId ? { key, versionId } : { key };
	try {
		await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }), {
			abortSignal: AbortSignal.timeout(options.cleanupTimeoutMs),
		});
		items.push({ id: 'delete', status: 'success' });
		if (versionId || versioning === 'disabled') {
			items.push({ id: 'cleanup', status: 'success', code: 'deleted' });
		} else {
			// A plain delete on a versioned (or unknown) bucket may only add a delete marker.
			items.push({ id: 'cleanup', status: 'warn', code: 'delete-marker-only', data: { key } });
		}
	} catch (error) {
		const c = classifyError(error);
		if (isIndeterminate(c)) {
			items.push({ id: 'delete', status: 'warn', code: c.category });
			items.push({ id: 'cleanup', status: 'warn', code: 'result-unknown', data: leftover });
		} else {
			items.push({ id: 'delete', status: 'fail', code: c.category });
			items.push({ id: 'cleanup', status: 'fail', code: 'delete-failed', data: leftover });
		}
	}
	return items;
}
