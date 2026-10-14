export type DiagnosticStatus = 'success' | 'fail' | 'warn' | 'unverified' | 'skipped';

export type DiagnosticId =
	| 'profile'
	| 'credentials'
	| 'identity'
	| 'bucket'
	| 'publicAccessBlock'
	| 'versioning'
	| 'put'
	| 'get'
	| 'delete'
	| 'cleanup';

export interface DiagnosticItem {
	id: DiagnosticId;
	status: DiagnosticStatus;
	/** Machine-readable outcome or error code, translated by the UI. */
	code?: string;
	/** Display values. Must already be redacted where needed. */
	data?: Record<string, string>;
}

export interface DiagnosticReport {
	items: DiagnosticItem[];
	aborted: boolean;
	/** Present only when the SSO session has to be renewed. */
	ssoLoginCommand?: string;
}

export function abortError(): Error {
	const e = new Error('The operation was aborted.');
	e.name = 'AbortError';
	return e;
}

/** Rejects as soon as `signal` aborts, even if `promise` cannot be cancelled itself. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	// The losing promise may still settle later; never let it surface as an unhandled rejection.
	promise.catch(() => undefined);
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError());
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		);
	});
}
