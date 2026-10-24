// S3 requests of the upload and the classification of their outcomes (design 6-1, 6-2).
// The upload-specific statuses (412, 409, digest errors) are decided here, before the general classifyError.
import { HeadObjectCommand, type HeadObjectCommandOutput, PutObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { classifyError } from '../aws/errors';
import { isSha256Hex } from '../settings/history';

/**
 * The client for uploads: one attempt per request (the uploader decides every retry, 6-4) and static credentials
 * that already passed the gate. The header tests use this same function.
 */
export function uploadClient(config: Pick<S3ClientConfig, 'region' | 'endpoint' | 'forcePathStyle' | 'credentials' | 'requestHandler'>): S3Client {
	return new S3Client({ ...config, maxAttempts: 1 });
}

/**
 * Design 2-3 (rev.5): a Put has no limit on its total time, only on inactivity (the handler's socketTimeout), and a
 * long one is stopped by the user. The handler's requestTimeout runs until the response starts, so it would cut a
 * large upload that is still sending; 0 turns it off for the Put.
 */
export const PUT_REQUEST_TIMEOUT_MS = 0;

/** S3 expects the SHA-256 checksum as base64 of the raw digest. */
export function checksumOf(sha256Hex: string): string {
	if (!isSha256Hex(sha256Hex)) throw new Error('not a SHA-256 hex digest');
	return Buffer.from(sha256Hex, 'hex').toString('base64');
}

export function headCommand(bucket: string, key: string): HeadObjectCommand {
	// Without ChecksumMode the response carries no ChecksumSHA256 (Step 1).
	return new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' });
}

/**
 * Conditional Put that never overwrites, with the checksum the job computed (the SDK sends it as given).
 * `contentType` is one of the fixed strings of fileType.ts (I14 (d)); no Content-Disposition is ever set.
 */
export function putCommand(bucket: string, key: string, body: Uint8Array, sentSha256: string, contentType: string): PutObjectCommand {
	return new PutObjectCommand({
		Bucket: bucket,
		Key: key,
		Body: body,
		ContentType: contentType,
		ContentLength: body.byteLength,
		ChecksumAlgorithm: 'SHA256',
		ChecksumSHA256: checksumOf(sentSha256),
		IfNoneMatch: '*',
	});
}

/** delivery-mismatch: the bytes match but the object is served in another form (I14 (e)); handled as a mismatch. */
export type HeadContent = 'match' | 'mismatch' | 'delivery-mismatch';

/** What a public object must also be served as: our fixed Content-Type, exactly, and no Content-Disposition. */
export interface DeliveryExpectation {
	contentType: string;
}

/**
 * The object holds exactly the bytes we would send: same full-object SHA-256. Anything else is a mismatch.
 * With `expect` (public items, design 3-4), the Content-Type must be the same string and there must be no
 * Content-Disposition; S3 does not normalise either, so another tool's spelling is not ours.
 */
export function compareHead(
	output: Pick<HeadObjectCommandOutput, 'ChecksumSHA256' | 'ChecksumType' | 'ContentType' | 'ContentDisposition'>,
	sentSha256: string,
	expect?: DeliveryExpectation,
): HeadContent {
	if (output.ChecksumType !== undefined && output.ChecksumType !== 'FULL_OBJECT') return 'mismatch';
	if (output.ChecksumSHA256 !== checksumOf(sentSha256)) return 'mismatch';
	if (expect && (output.ContentType !== expect.contentType || output.ContentDisposition !== undefined)) return 'delivery-mismatch';
	return 'match';
}

export type HeadOutcome = 'aborted' | 'head-forbidden' | 'absent' | 'indeterminate' | 'failed';
export type PutOutcome = 'indeterminate' | 'precondition' | 'conflict' | 'digest' | 'forbidden' | 'failed';

export interface Classified<T> {
	outcome: T;
	/** For the record and the log: a classification, never raw request or response data. */
	code: string;
	httpStatus?: number;
}

const DIGEST_CODES = ['BadDigest', 'InvalidDigest', 'XAmzContentSHA256Mismatch'];

/**
 * Classifies a failed Head or Put (6-2). `aborted` tells whether our own signal (job abort, authentication
 * change) stopped the request: a stopped Put may still have been applied, so it is indeterminate.
 * Called only for requests that were started.
 */
export function classifyS3Outcome(op: 'head', error: unknown, aborted: boolean): Classified<HeadOutcome>;
export function classifyS3Outcome(op: 'put', error: unknown, aborted: boolean): Classified<PutOutcome>;
export function classifyS3Outcome(op: 'head' | 'put', error: unknown, aborted: boolean): Classified<HeadOutcome | PutOutcome> {
	const c = classifyError(error);
	const status = c.httpStatus;
	const result = (outcome: HeadOutcome | PutOutcome) => ({ outcome, code: c.code, ...(status === undefined ? {} : { httpStatus: status }) });
	if (aborted) return result(op === 'put' ? 'indeterminate' : 'aborted');
	if (status === 412) return result(op === 'put' ? 'precondition' : 'failed');
	if (status === 409) return result(op === 'put' ? 'conflict' : 'failed');
	if (status === 400 && DIGEST_CODES.includes(c.code)) return result(op === 'put' ? 'digest' : 'failed');
	if (status === 403) return result(op === 'put' ? 'forbidden' : 'head-forbidden');
	if (status === 404 && op === 'head') return result('absent');
	if ((status !== undefined && status >= 500) || c.category === 'network' || c.category === 'timeout' || c.category === 'aborted') return result('indeterminate');
	if (status !== undefined && status >= 400 && status < 500) return result('failed');
	return result(op === 'put' ? 'indeterminate' : 'failed');
}
