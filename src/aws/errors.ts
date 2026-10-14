export type ErrorCategory =
	| 'sso-login-required'
	| 'profile-config'
	| 'access-denied'
	| 'not-found'
	| 'network'
	| 'timeout'
	| 'aborted'
	| 'unknown';

export interface ClassifiedError {
	category: ErrorCategory;
	/** Error name or service error code. Never contains account IDs, ARNs or tokens. */
	code: string;
	httpStatus?: number;
}

interface ErrorLike {
	name?: unknown;
	code?: unknown;
	message?: unknown;
	Code?: unknown;
	$metadata?: { httpStatusCode?: number };
}

const NETWORK_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'EPIPE'];
const TIMEOUT_CODES = ['ETIMEDOUT', 'TimeoutError', 'RequestTimeout', 'RequestTimeoutException'];

// Messages produced by @aws-sdk/credential-provider-sso / token-providers when the SSO session must be renewed.
const SSO_LOGIN_PATTERNS = [/run 'aws sso login'/i, /UnauthorizedException/, /Session token not found or invalid/i, /InvalidGrantException/];
const PROFILE_CONFIG_PATTERNS = [/Profile .* was not found/i, /is not configured with SSO credentials/i, /incomplete SSO/i];

function codeOf(e: ErrorLike): string {
	if (typeof e.Code === 'string') return e.Code;
	if (typeof e.name === 'string' && e.name !== 'Error') return e.name;
	if (typeof e.code === 'string') return e.code;
	return 'Error';
}

export function classifyError(error: unknown): ClassifiedError {
	const e: ErrorLike = typeof error === 'object' && error !== null ? error : {};
	const name = typeof e.name === 'string' ? e.name : '';
	const message = typeof e.message === 'string' ? e.message : '';
	const nodeCode = typeof e.code === 'string' ? e.code : '';
	const httpStatus = e.$metadata?.httpStatusCode;
	const code = codeOf(e);
	const result = (category: ErrorCategory): ClassifiedError => ({ category, code, httpStatus });

	if (name === 'AbortError') return result('aborted');
	if (name === 'CredentialsProviderError' || name === 'TokenProviderError') {
		if (SSO_LOGIN_PATTERNS.some((p) => p.test(message))) return result('sso-login-required');
		if (PROFILE_CONFIG_PATTERNS.some((p) => p.test(message))) return result('profile-config');
		if (TIMEOUT_CODES.some((c) => message.includes(c))) return result('timeout');
		if (NETWORK_CODES.some((c) => message.includes(c))) return result('network');
		return result('unknown');
	}
	if (TIMEOUT_CODES.includes(name) || TIMEOUT_CODES.includes(nodeCode)) return result('timeout');
	if (NETWORK_CODES.includes(nodeCode) || NETWORK_CODES.some((c) => message.includes(c))) return result('network');
	if (code === 'AccessDenied' || code === 'AccessDeniedException' || httpStatus === 403) return result('access-denied');
	if (code === 'NoSuchBucket' || code === 'NotFound' || code === 'NoSuchKey' || httpStatus === 404) return result('not-found');
	return result('unknown');
}

/** Errors whose outcome on the server is unknown (the request may or may not have been applied). */
export function isIndeterminate(c: ClassifiedError): boolean {
	return c.category === 'timeout' || c.category === 'network' || c.category === 'aborted' || c.category === 'unknown';
}
