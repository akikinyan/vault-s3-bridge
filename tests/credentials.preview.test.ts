import { describe, expect, it } from 'vitest';
import { SharedCredentials } from '../src/preview/credentials';
import { Clock, creds, gateDeps, handler, tick } from './fixtures/preview';
import { ssoErrors } from './fixtures/sdkErrors';

function hanging() {
	let resolve!: (v: ReturnType<typeof creds>) => void;
	const promise = new Promise<ReturnType<typeof creds>>((r) => (resolve = r));
	return { promise, resolve };
}

describe('SharedCredentials', () => {
	it('shares one resolution between concurrent requests', async () => {
		const clock = new Clock();
		const deps = gateDeps(clock);
		const shared = new SharedCredentials(deps, handler);
		const s = new AbortController().signal;
		const all = await Promise.all(Array.from({ length: 30 }, () => shared.get('c', 1, 'sso', 'ap-northeast-1', s)));
		expect(all).toHaveLength(30);
		expect(deps.resolve).toHaveBeenCalledTimes(1);
		expect(deps.callerArn).toHaveBeenCalledTimes(1);
		await shared.get('c', 1, 'sso', 'ap-northeast-1', s);
		expect(deps.resolve).toHaveBeenCalledTimes(1); // cached
	});

	it('keeps the shared resolution alive when one waiter leaves, and cancels it when all leave', async () => {
		const clock = new Clock();
		const h = hanging();
		let stsSignal: AbortSignal | undefined;
		const deps = gateDeps(clock, {
			resolve: () => h.promise,
			callerArn: async (_c, _r, _h, signal) => {
				stsSignal = signal;
				return 'arn:aws:sts::123456789012:assumed-role/R/s';
			},
		});
		const shared = new SharedCredentials(deps, handler);
		const a = new AbortController();
		const b = new AbortController();
		const pa = shared.get('c', 1, 'sso', 'r', a.signal);
		const pb = shared.get('c', 1, 'sso', 'r', b.signal);
		a.abort();
		await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
		h.resolve(creds());
		await expect(pb).resolves.toMatchObject({ sessionToken: 't' });
		expect(stsSignal?.aborted).toBe(false);

		// Now everyone leaves a fresh resolution: it is cancelled and not cached.
		const h2 = hanging();
		deps.resolve.mockImplementation(() => h2.promise);
		const c = new AbortController();
		const pc = shared.get('c', 2, 'sso', 'r', c.signal);
		c.abort();
		await expect(pc).rejects.toMatchObject({ name: 'AbortError' });
		h2.resolve(creds());
		await tick();
		const again = shared.get('c', 2, 'sso', 'r', new AbortController().signal);
		h2.resolve(creds());
		await again;
		expect(deps.resolve).toHaveBeenCalledTimes(3); // gen1 once, gen2 twice (cancelled result was not cached)
	});

	it('caches real failures for 15 seconds but never cancellations', async () => {
		const clock = new Clock();
		const deps = gateDeps(clock, { resolve: async () => Promise.reject(ssoErrors.noCache) });
		const shared = new SharedCredentials(deps, handler);
		const s = new AbortController().signal;
		await expect(shared.get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'sso-login-required' });
		await tick();
		await expect(shared.get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'sso-login-required' });
		expect(deps.resolve).toHaveBeenCalledTimes(1);
		clock.t += 16_000;
		await expect(shared.get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'sso-login-required' });
		expect(deps.resolve).toHaveBeenCalledTimes(2);
	});

	it('runs the authentication gate', async () => {
		const clock = new Clock();
		const s = new AbortController().signal;
		const notSso = gateDeps(clock, { loadConfig: async () => ({ configFile: { sso: { aws_access_key_id: 'AKIAIOSFODNN7EXAMPLE' } }, credentialsFile: {} }) });
		await expect(new SharedCredentials(notSso, handler).get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'profile-rejected' });
		expect(notSso.resolve).not.toHaveBeenCalled();
		const user = gateDeps(clock, { callerArn: async () => 'arn:aws:iam::123456789012:user/alice' });
		await expect(new SharedCredentials(user, handler).get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'profile-rejected' });
		const noToken = gateDeps(clock, { resolve: async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 's' }) });
		await expect(new SharedCredentials(noToken, handler).get('c', 1, 'sso', 'r', s)).rejects.toMatchObject({ code: 'profile-rejected' });
	});

	it('separates generations and refreshes before expiry', async () => {
		const clock = new Clock();
		const deps = gateDeps(clock);
		const shared = new SharedCredentials(deps, handler);
		const s = new AbortController().signal;
		await shared.get('c', 1, 'sso', 'r', s);
		await shared.get('c', 2, 'sso', 'r', s);
		expect(deps.resolve).toHaveBeenCalledTimes(2);
		clock.t += 56 * 60_000; // within 5 minutes of the 1-hour expiry
		await shared.get('c', 2, 'sso', 'r', s);
		expect(deps.resolve).toHaveBeenCalledTimes(3);
		shared.invalidate('c');
		await shared.get('c', 2, 'sso', 'r', s);
		expect(deps.resolve).toHaveBeenCalledTimes(4);
	});
});
