import { describe, expect, it } from 'vitest';
import { appendHistoryOp, deleteConnectionOp, parseFolders, saveConnectionOp, setFieldOp } from '../src/settings/ops';
import { SettingsStore } from '../src/settings/store';
import type { HistoryEntry, StorageConnection } from '../src/settings/types';
import { connectionWarnings, validateConnectionFields } from '../src/settings/validate';
import { MemoryStoreIO } from './fixtures/uploadFakes';

const priv: StorageConnection = { id: 'c1', alias: 'work', provider: 'aws-s3', classification: 'private', bucket: 'example-private', region: 'ap-northeast-1', keyTemplate: 'k/{filename}.{ext}' };
const pub: StorageConnection = {
	id: 'c2',
	alias: 'blog',
	provider: 'aws-s3',
	classification: 'public',
	bucket: 'example-public',
	region: 'ap-northeast-1',
	publicBaseUrl: 'https://cdn.example.com',
	keyTemplate: 'p/{hash}.{ext}',
};

async function store(): Promise<{ s: SettingsStore; io: MemoryStoreIO }> {
	const io = new MemoryStoreIO([]);
	const s = new SettingsStore(io);
	await s.reload();
	await s.mutate(saveConnectionOp(undefined, priv, 'p'));
	return { s, io };
}

describe('upload settings (11-3)', () => {
	it('saves each field, and reading data.json again keeps it (same bounds as the migration)', async () => {
		const { s, io } = await store();
		const set = async (k: Parameters<typeof setFieldOp>[0], v: unknown) => (await s.mutate(setFieldOp(k, v))).ok;
		expect(await set('defaultConnectionId', 'c1')).toBe(true);
		expect(await set('webpEnabled', true)).toBe(true);
		expect(await set('webpQuality', 73)).toBe(true);
		expect(await set('stripPrivate', true)).toBe(true);
		expect(await set('uploadMaxFileMB', 30)).toBe(true);
		expect(await set('uploadMaxJobMB', 500)).toBe(true);
		expect(await set('excludeFolders', '/Private/\nArchive , Private\n\n')).toBe(true);
		expect(await set('historyLimit', 5000)).toBe(true);
		const expected = { defaultConnectionId: 'c1', webp: { enabled: true, quality: 0.73 }, stripPrivate: true, maxFileMB: 30, maxOtherFileMB: 100, maxJobMB: 500, excludeFolders: ['Archive', 'Private'] };
		expect(s.current.upload).toEqual(expected);
		expect(s.current.historyLimit).toBe(5000);
		// The preview limit is a different setting.
		expect(s.current.preview.maxFileMB).toBe(20);
		const again = new SettingsStore(io);
		await again.reload();
		expect(again.current.upload).toEqual(expected);
		expect(again.current.historyLimit).toBe(5000);
	});

	it('rejects values out of bounds without saving', async () => {
		const { s } = await store();
		const before = JSON.stringify(s.current);
		for (const [k, v] of [
			['webpQuality', 49],
			['webpQuality', 101],
			['uploadMaxFileMB', 0],
			['uploadMaxFileMB', 101],
			['uploadMaxJobMB', 9],
			['uploadMaxJobMB', 1001],
			['historyLimit', 99],
			['historyLimit', 20001],
			['uploadMaxFileMB', 'x'],
		] as const) {
			expect((await s.mutate(setFieldOp(k, v))).ok, `${k}=${v}`).toBe(false);
		}
		expect(JSON.stringify(s.current)).toBe(before);
	});

	it('the default connection must exist in the latest settings; empty clears it', async () => {
		const { s } = await store();
		expect((await s.mutate(setFieldOp('defaultConnectionId', 'gone'))).ok).toBe(false);
		await s.mutate(setFieldOp('defaultConnectionId', 'c1'));
		expect((await s.mutate(setFieldOp('defaultConnectionId', ''))).ok).toBe(true);
		expect(s.current.upload.defaultConnectionId).toBeUndefined();
		await s.mutate(deleteConnectionOp('c1'));
		expect((await s.mutate(setFieldOp('defaultConnectionId', 'c1'))).ok).toBe(false);
	});

	it('a lower history limit trims the history on save', async () => {
		const { s } = await store();
		const h = (i: number): HistoryEntry => ({
			id: `h${i}`,
			target: 'aws:example-private',
			key: `k/${i}`,
			classification: 'private',
			sourceSha256: String(i % 10).repeat(64),
			sentSha256: String(i % 10).repeat(64),
			size: 1,
			format: 'png',
			converter: 'c1;orig',
			at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
		});
		await s.mutate(appendHistoryOp(Array.from({ length: 150 }, (_, i) => h(i))));
		expect(s.current.history).toHaveLength(150);
		await s.mutate(setFieldOp('historyLimit', 100));
		expect(s.current.history).toHaveLength(100);
	});

	it('parseFolders', () => {
		expect(parseFolders('')).toEqual([]);
		expect(parseFolders(' a/b/ ,c\n/a/b')).toEqual(['a/b', 'c']);
	});
});

describe('connection checks (11-3, plan 2-8)', () => {
	it('an invalid key template is a save error, checked against the latest settings', async () => {
		expect(validateConnectionFields({ ...priv, keyTemplate: 'k/{nope}.{ext}' }, [])).toContain('template-invalid');
		expect(validateConnectionFields({ ...priv, keyTemplate: '/k/{hash}' }, [])).toContain('template-invalid');
		expect(validateConnectionFields(priv, [])).toEqual([]);
		const { s } = await store();
		const r = await s.mutate(saveConnectionOp(priv, { ...priv, keyTemplate: 'k//{hash}' }, 'p'));
		expect(r.ok).toBe(false);
		expect(s.current.connections[0]!.keyTemplate).toBe(priv.keyTemplate);
	});

	it('warnings: a missing or invalid public base URL and name-revealing public keys; none for a good private connection', () => {
		const keys = (c: Parameters<typeof connectionWarnings>[0]) => connectionWarnings(c).map((w) => w.key);
		expect(keys(priv)).toEqual([]);
		expect(keys(pub)).toEqual([]);
		expect(keys({ ...pub, publicBaseUrl: undefined })).toEqual(['edit.publicBaseUrlNeeded']);
		expect(keys({ ...pub, publicBaseUrl: 'http://cdn.example.com' })).toEqual(['edit.publicBaseUrlNeeded']);
		expect(connectionWarnings({ ...pub, keyTemplate: 'p/{notename}/{hash}.{ext}' })).toEqual([{ key: 'upload.confirm.identifying', params: { vars: '{notename}' } }]);
		// Private keys may contain names: no warning there.
		expect(keys({ ...priv, keyTemplate: 'k/{notename}/{filename}.{ext}' })).toEqual([]);
		expect(connectionWarnings({ ...priv, keyTemplate: 'k/{nope}' })).toEqual([{ key: 'edit.templateUnknown', params: { name: 'nope' } }]);
		expect(keys({ ...priv, keyTemplate: 'k/../{hash}' })).toEqual(['edit.templateInvalid']);
	});
});
