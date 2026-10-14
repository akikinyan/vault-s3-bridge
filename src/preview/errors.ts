export type PreviewErrorCode =
	| 'invalid-reference'
	| 'unknown-alias'
	| 'alias-conflict'
	| 'connection-missing'
	| 'public-connection'
	| 'profile-not-set'
	| 'profile-rejected'
	| 'sso-login-required'
	| 'access-denied'
	| 'not-found'
	| 'too-large'
	| 'too-many-pixels'
	| 'unsupported-format'
	| 'unsupported-svg'
	| 'network'
	| 'timeout'
	| 'aborted'
	| 'unknown';

export class PreviewError extends Error {
	constructor(
		readonly code: PreviewErrorCode,
		readonly detail?: Record<string, string>,
	) {
		super(code);
		this.name = 'PreviewError';
	}
}
