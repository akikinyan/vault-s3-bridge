import { describe, expect, it } from 'vitest';
import { Limiter } from '../src/preview/limiter';

describe('Limiter', () => {
	it('runs at most N at a time and drops aborted waiters', async () => {
		const limiter = new Limiter(2);
		const r1 = await limiter.acquire();
		await limiter.acquire();
		const controller = new AbortController();
		const third = limiter.acquire(controller.signal);
		const fourth = limiter.acquire();
		expect(limiter.waiting).toBe(2);
		controller.abort();
		await expect(third).rejects.toMatchObject({ name: 'AbortError' });
		expect(limiter.waiting).toBe(1);
		r1();
		r1(); // idempotent
		await fourth;
		expect(limiter.running).toBe(2);
		expect(limiter.waiting).toBe(0);
	});
});
