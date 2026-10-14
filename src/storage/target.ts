/**
 * Identifies the physical storage a connection points to, independent of its alias.
 * AWS bucket names are globally unique, so any AWS endpoint maps to `aws:<bucket>`.
 */
export type TargetKey = string;

const AWS_HOST = /(^|\.)amazonaws\.com(\.cn)?$/;

export function targetKey(bucket: string, endpoint: string | undefined): TargetKey {
	if (!endpoint) return `aws:${bucket}`;
	let host: string;
	try {
		const url = new URL(endpoint);
		host = url.hostname.toLowerCase();
		if (AWS_HOST.test(host)) return `aws:${bucket}`;
		if (url.port && url.port !== '443') host = `${host}:${url.port}`;
	} catch {
		host = endpoint.trim().toLowerCase();
	}
	return `s3c:${host}/${bucket}`;
}
