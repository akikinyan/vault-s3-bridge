import { describe, expect, it } from 'vitest';
import { formatReference } from '../src/reference/reference';
import { setProfile } from '../src/settings/device';
import { mergeRecords, recordConnection, recordsOf } from '../src/settings/registry';
import { body, connection, controllableSend, pngBytes, settingsWith, setupService, tick } from './fixtures/preview';
import { serviceError } from './fixtures/sdkErrors';

const REF = formatReference('work', 'img/a.png');
const MB = 1024 * 1024;

describe('PreviewService — checks before network access', () => {
	it.each([
		['not a reference', 's3-bridge://Bad/x.png', 'invalid-reference'],
		['unknown alias', formatReference('nosuch', 'a.png'), 'unknown-alias'],
	])('%s', async (_name, src, code) => {
		const t = setupService();
		await expect(t.service.acquire(src).result).rejects.toMatchObject({ code });
		expect(t.calls).toEqual([]);
		expect(t.gate.resolve).not.toHaveBeenCalled();
	});

	it('does not access the network for a conflicting alias', async () => {
		const s = settingsWith(connection());
		Object.assign(s, mergeRecords(recordsOf(s), recordConnection(recordsOf(s), connection({ id: 'c2', bucket: 'y' }))));
		const t = setupService({ settings: s });
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'alias-conflict' });
		expect(t.calls).toEqual([]);
	});

	it('refuses public connections', async () => {
		const t = setupService({ settings: settingsWith(connection({ classification: 'public' })) });
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'public-connection' });
		expect(t.calls).toEqual([]);
	});

	it('refuses when this device has no profile, even with a cached image', async () => {
		const t = setupService();
		const first = t.service.acquire(REF);
		await first.result;
		setProfile(t.device, 'c-work', undefined);
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'profile-not-set' });
		expect(t.gets()).toHaveLength(1);
	});

	it('refuses when the binding exists but the connection is missing on this device', async () => {
		const s = settingsWith(connection());
		s.connections = [];
		const t = setupService({ settings: s });
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'connection-missing' });
	});
});

describe('PreviewService — fetching', () => {
	it('returns a blob URL with size, and shares one download per image', async () => {
		const t = setupService();
		const [a, b] = [t.service.acquire(REF), t.service.acquire(REF)];
		const [ra, rb] = await Promise.all([a.result, b.result]);
		expect(ra).toEqual({ url: 'blob:test/1', width: 10, height: 10 });
		expect(rb.url).toBe(ra.url);
		expect(t.gets()).toHaveLength(1);
		expect(t.gets()[0]).toMatchObject({ bucket: 'x', key: 'img/a.png' });
	});

	it('enforces the file size limit from ContentLength and from bytes actually read', async () => {
		const unread = body(pngBytes(1, 1));
		const big = setupService({ send: async () => ({ ContentLength: 21 * MB, Body: unread }) });
		await expect(big.service.acquire(REF).result).rejects.toMatchObject({ code: 'too-large' });
		expect(unread.destroyed).toBe(true);
		expect(big.gets()[0]!.signal?.aborted).toBe(true);
		const stream = body(pngBytes(1, 1, 21 * MB));
		const lying = setupService({ send: async () => ({ ContentLength: 10, Body: stream }) });
		await expect(lying.service.acquire(REF).result).rejects.toMatchObject({ code: 'too-large' });
		expect(stream.destroyed).toBe(true);
	});

	it('enforces the pixel limit and rejects SVG and other formats', async () => {
		const huge = setupService({ send: async () => ({ Body: body(pngBytes(8000, 6000)) }) });
		await expect(huge.service.acquire(REF).result).rejects.toMatchObject({ code: 'too-many-pixels' });
		const svg = setupService({ send: async () => ({ Body: body(new TextEncoder().encode('<svg/>')) }) });
		await expect(svg.service.acquire(REF).result).rejects.toMatchObject({ code: 'unsupported-svg' });
		const txt = setupService({ send: async () => ({ Body: body(new TextEncoder().encode('hello')) }) });
		await expect(txt.service.acquire(REF).result).rejects.toMatchObject({ code: 'unsupported-format' });
	});

	it('caches failures briefly', async () => {
		const t = setupService({ send: async () => Promise.reject(serviceError('NoSuchKey', 404)) });
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'not-found' });
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'not-found' });
		expect(t.gets()).toHaveLength(1);
		t.clock.t += 16_000;
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'not-found' });
		expect(t.gets()).toHaveLength(2);
	});

	it('does not share between connections or authentication generations', async () => {
		const s = settingsWith(connection(), connection({ id: 'c-2', alias: 'work2' }));
		const t = setupService({ settings: s });
		await t.service.acquire(REF).result;
		await t.service.acquire(formatReference('work2', 'img/a.png')).result;
		expect(t.gets()).toHaveLength(2); // same bucket and key, different connections
		setProfile(t.device, 'c-work', 'other');
		t.service.invalidateConnection('c-work');
		await t.service.acquire(REF).result;
		expect(t.gets()).toHaveLength(3);
	});
});

describe('PreviewService — lifecycle', () => {
	it('keeps a shared download when one user leaves and aborts it when the last leaves', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const a = t.service.acquire(REF);
		const b = t.service.acquire(REF);
		await tick();
		await tick();
		expect(c.pending).toHaveLength(1);
		a.release();
		expect(c.pending[0]!.signal?.aborted).toBe(false);
		b.release();
		expect(c.pending[0]!.signal?.aborted).toBe(true);
		expect(t.service.stats().entries).toBe(0);
	});

	it('never shows or caches a result that finishes after invalidation', async () => {
		let finish!: () => void;
		const t = setupService({
			send: () =>
				new Promise((resolve) => {
					finish = () => resolve({ Body: body(pngBytes(10, 10)) });
				}),
		});
		const lease = t.service.acquire(REF);
		await tick();
		await tick();
		t.service.invalidateConnection('c-work');
		finish();
		await expect(lease.result).rejects.toMatchObject({ code: 'aborted' });
		await tick();
		expect(t.urls.created.every((u) => t.urls.revoked.includes(u))).toBe(true);
		expect(t.service.stats().ready).toBe(0);
	});

	it('revokes a URL created just as the connection is invalidated', async () => {
		let invalidate = () => {};
		const racing = {
			destroy() {},
			async *[Symbol.asyncIterator]() {
				yield pngBytes(10, 10);
				invalidate(); // after the last chunk was checked, before the URL is created
			},
		};
		const t = setupService({ send: async () => ({ Body: racing }) });
		invalidate = () => t.service.invalidateConnection('c-work');
		const lease = t.service.acquire(REF);
		await expect(lease.result).rejects.toMatchObject({ code: 'aborted' });
		await tick();
		expect(t.urls.created).toEqual(['blob:test/1']);
		expect(t.urls.revoked).toEqual(['blob:test/1']);
		expect(t.service.stats().ready).toBe(0);
	});

	it('revokes a URL created just as the service is destroyed', async () => {
		let destroy = () => {};
		const racing = {
			destroy() {},
			async *[Symbol.asyncIterator]() {
				yield pngBytes(10, 10);
				destroy();
			},
		};
		const t = setupService({ send: async () => ({ Body: racing }) });
		destroy = () => t.service.destroy();
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'aborted' });
		await tick();
		expect(t.urls.created).toHaveLength(1);
		expect(t.urls.revoked).toEqual(t.urls.created);
	});

	it('never shows or caches a result that finishes after destroy', async () => {
		let finish!: () => void;
		const t = setupService({ send: () => new Promise((resolve) => (finish = () => resolve({ Body: body(pngBytes(10, 10)) }))) });
		const lease = t.service.acquire(REF);
		await tick();
		await tick();
		t.service.destroy();
		finish();
		await expect(lease.result).rejects.toMatchObject({ code: 'aborted' });
		await tick();
		expect(t.urls.created.every((u) => t.urls.revoked.includes(u))).toBe(true);
		await expect(t.service.acquire(REF).result).rejects.toMatchObject({ code: 'aborted' });
	});

	it('rejects a released lease even if the shared download later succeeds', async () => {
		let finish!: () => void;
		const t = setupService({ send: () => new Promise((resolve) => (finish = () => resolve({ Body: body(pngBytes(10, 10)) }))) });
		const a = t.service.acquire(REF);
		const b = t.service.acquire(REF);
		await tick();
		await tick();
		a.release();
		finish();
		await expect(a.result).rejects.toMatchObject({ name: 'AbortError' });
		await expect(b.result).resolves.toMatchObject({ width: 10 });
	});

	it('evicts unused images beyond the cache budget and revokes their URLs', async () => {
		const s = settingsWith(connection());
		s.preview.cacheMB = 0.0001; // ~100 bytes: room for one 64-byte image
		const t = setupService({ settings: s });
		const refs = ['a.png', 'b.png', 'c.png'].map((k) => formatReference('work', k));
		for (const ref of refs) {
			const lease = t.service.acquire(ref);
			await lease.result;
			lease.release();
			t.clock.t += 1;
		}
		expect(t.service.stats().ready).toBe(1);
		expect(t.urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
	});

	it('keeps displayed images regardless of the budget', async () => {
		const s = settingsWith(connection());
		s.preview.cacheMB = 0.00001;
		const t = setupService({ settings: s });
		const leases = ['a.png', 'b.png'].map((k) => t.service.acquire(formatReference('work', k)));
		await Promise.all(leases.map((l) => l.result));
		expect(t.service.stats().ready).toBe(2);
		expect(t.urls.revoked).toEqual([]);
	});

	it('limits concurrent downloads to three', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const leases = ['a', 'b', 'c', 'd', 'e'].map((k) => t.service.acquire(formatReference('work', `${k}.png`)));
		for (let i = 0; i < 5; i++) await tick();
		expect(c.pending).toHaveLength(3);
		c.pending[0]!.resolve({ Body: body(pngBytes(1, 1)) });
		await leases[0]!.result;
		for (let i = 0; i < 5; i++) await tick();
		expect(c.pending).toHaveLength(4);
		leases.forEach((l) => l.release());
	});

	it('checks existence with HeadObject through the same gate', async () => {
		const t = setupService({ send: async (cmd) => (cmd.constructor.name === 'HeadObjectCommand' ? {} : Promise.reject(new Error('x'))) });
		await expect(t.service.exists(REF, new AbortController().signal)).resolves.toBe(true);
		const missing = setupService({ send: async () => Promise.reject(serviceError('NotFound', 404)) });
		await expect(missing.service.exists(REF, new AbortController().signal)).rejects.toMatchObject({ code: 'not-found' });
	});

	it('aborts an existence check when its connection is invalidated', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const check = t.service.exists(REF, new AbortController().signal);
		await tick();
		await tick();
		expect(c.pending).toHaveLength(1);
		t.service.invalidateConnection('c-work');
		expect(c.pending[0]!.signal?.aborted).toBe(true);
		await expect(check).rejects.toMatchObject({ code: 'aborted' });
	});

	it('does not report existence when the connection was invalidated while the request finished', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const check = t.service.exists(REF, new AbortController().signal);
		await tick();
		await tick();
		t.service.invalidateConnection('c-work');
		c.pending[0]!.resolve({});
		await expect(check).rejects.toMatchObject({ code: 'aborted' });
	});

	it('aborts existence checks on destroy and refuses new ones', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const check = t.service.exists(REF, new AbortController().signal);
		await tick();
		await tick();
		t.service.destroy();
		expect(c.pending[0]!.signal?.aborted).toBe(true);
		await expect(check).rejects.toMatchObject({ code: 'aborted' });
		await expect(t.service.exists(REF, new AbortController().signal)).rejects.toMatchObject({ code: 'aborted' });
		expect(c.pending).toHaveLength(1);
	});

	it('aborts the request when the caller aborts', async () => {
		const c = controllableSend();
		const t = setupService({ send: c.send });
		const caller = new AbortController();
		const check = t.service.exists(REF, caller.signal);
		await tick();
		await tick();
		caller.abort();
		expect(c.pending[0]!.signal?.aborted).toBe(true);
		await expect(check).rejects.toBeDefined();
	});
});
