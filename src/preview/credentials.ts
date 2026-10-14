import type { NodeHttpHandler } from '@smithy/node-http-handler';
import type { AwsCredentialIdentity } from '@smithy/types';
import { checkResolvedCredentials } from '../aws/credentials';
import { classifyError } from '../aws/errors';
import { checkProfile, type SharedConfig } from '../aws/profiles';
import { abortError, raceAbort } from '../diagnostics/types';
import { PreviewError } from './errors';

export interface CredentialGateDeps {
	loadConfig(): Promise<SharedConfig>;
	resolve(profile: string, handler: NodeHttpHandler): Promise<AwsCredentialIdentity>;
	/** Returns the caller ARN (GetCallerIdentity). */
	callerArn(credentials: AwsCredentialIdentity, region: string, handler: NodeHttpHandler, signal: AbortSignal): Promise<string | undefined>;
	now(): number;
}

const REFRESH_MARGIN_MS = 5 * 60_000;
export const FAILURE_TTL_MS = 15_000;

/** Runs the authentication gate: SSO-only profile, temporary credentials, assumed role. */
async function gate(deps: CredentialGateDeps, profile: string, region: string, handler: NodeHttpHandler, signal: AbortSignal) {
	if (!checkProfile(await deps.loadConfig(), profile).ok) throw new PreviewError('profile-rejected');
	let credentials: AwsCredentialIdentity;
	try {
		credentials = await raceAbort(deps.resolve(profile, handler), signal);
	} catch (error) {
		throw toPreviewError(error);
	}
	let arn: string | undefined;
	try {
		arn = await deps.callerArn(credentials, region, handler, signal);
	} catch (error) {
		throw toPreviewError(error);
	}
	if (!checkResolvedCredentials(credentials, arn).ok) throw new PreviewError('profile-rejected');
	return credentials;
}

export function toPreviewError(error: unknown): PreviewError {
	if (error instanceof PreviewError) return error;
	const c = classifyError(error);
	switch (c.category) {
		case 'sso-login-required':
			return new PreviewError('sso-login-required');
		case 'profile-config':
			return new PreviewError('profile-rejected');
		case 'access-denied':
		case 'not-found':
		case 'network':
		case 'timeout':
		case 'aborted':
			return new PreviewError(c.category);
		default:
			return new PreviewError('unknown');
	}
}

type Entry =
	| { state: 'pending'; promise: Promise<AwsCredentialIdentity>; waiters: number; controller: AbortController }
	| { state: 'ready'; credentials: AwsCredentialIdentity }
	| { state: 'failed'; error: PreviewError; until: number };

/**
 * Temporary credentials shared per connection and authentication generation.
 * Concurrent requests share one resolution; it is cancelled only when every waiter has left.
 * Cancellations are never cached as failures.
 */
export class SharedCredentials {
	private readonly entries = new Map<string, Entry>();

	constructor(
		private readonly deps: CredentialGateDeps,
		private readonly handler: NodeHttpHandler,
	) {}

	get(connectionId: string, generation: number, profile: string, region: string, signal: AbortSignal): Promise<AwsCredentialIdentity> {
		if (signal.aborted) return Promise.reject(abortError());
		const key = `${connectionId}|${generation}`;
		const now = this.deps.now();
		let entry = this.entries.get(key);
		if (entry?.state === 'ready') {
			const exp = entry.credentials.expiration?.getTime();
			if (exp === undefined || exp - now > REFRESH_MARGIN_MS) return Promise.resolve(entry.credentials);
			entry = undefined;
		}
		if (entry?.state === 'failed') {
			if (entry.until > now) return Promise.reject(entry.error);
			entry = undefined;
		}
		const pending: Entry & { state: 'pending' } = entry?.state === 'pending' ? entry : this.start(key, profile, region);
		pending.waiters++;
		let left = false;
		const leave = () => {
			if (left) return;
			left = true;
			pending.waiters--;
			if (pending.waiters === 0 && this.entries.get(key) === pending) {
				pending.controller.abort();
				this.entries.delete(key);
			}
		};
		signal.addEventListener('abort', leave, { once: true });
		return raceAbort<AwsCredentialIdentity>(pending.promise, signal).finally(() => {
			signal.removeEventListener('abort', leave);
			leave();
		});
	}

	private start(key: string, profile: string, region: string): Entry & { state: 'pending' } {
		const controller = new AbortController();
		const promise = gate(this.deps, profile, region, this.handler, controller.signal);
		const entry: Entry & { state: 'pending' } = { state: 'pending', promise, waiters: 0, controller };
		this.entries.set(key, entry);
		promise.then(
			(credentials) => {
				if (this.entries.get(key) === entry && !controller.signal.aborted) this.entries.set(key, { state: 'ready', credentials });
			},
			(error: unknown) => {
				if (this.entries.get(key) !== entry || controller.signal.aborted) return;
				const e = toPreviewError(error);
				if (e.code === 'aborted') this.entries.delete(key);
				else this.entries.set(key, { state: 'failed', error: e, until: this.deps.now() + FAILURE_TTL_MS });
			},
		);
		return entry;
	}

	invalidate(connectionId: string): void {
		for (const [key, entry] of this.entries) {
			if (!key.startsWith(`${connectionId}|`)) continue;
			if (entry.state === 'pending') entry.controller.abort();
			this.entries.delete(key);
		}
	}

	clear(): void {
		for (const entry of this.entries.values()) if (entry.state === 'pending') entry.controller.abort();
		this.entries.clear();
	}
}
