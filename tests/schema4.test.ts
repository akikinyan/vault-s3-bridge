import { describe, expect, it } from 'vitest';
import { emptyDeviceState } from '../src/settings/device';
import { mergeHistory } from '../src/settings/history';
import { loadSettings } from '../src/settings/migrate';
import { DEFAULT_PREVIEW, DEFAULT_UPLOAD, type HistoryEntry } from '../src/settings/types';

const h = (n: number) => n.toString(16).padStart(64, '0');
const entry = (format: string): Record<string, unknown> => ({
	id: `e-${format}`,
	target: 'aws:pub',
	key: `k/x.${format}`,
	classification: 'public',
	sourceSha256: h(1),
	sentSha256: h(1),
	size: 10,
	format,
	converter: 'c1;orig',
	at: '2026-10-19T00:00:00.000Z',
});

describe('schemaVersion 4 (design 1-1)', () => {
	it('migrates v3 by adding the new limits, and saves it as v4', () => {
		const { settings, readOnly, changed } = loadSettings({ schemaVersion: 3, upload: { maxFileMB: 30 }, preview: { maxFileMB: 10 } }, emptyDeviceState());
		expect(readOnly).toBe(false);
		expect(changed).toBe(true);
		expect(settings.schemaVersion).toBe(4);
		expect(settings.upload).toMatchObject({ maxFileMB: 30, maxOtherFileMB: DEFAULT_UPLOAD.maxOtherFileMB });
		expect(settings.preview).toMatchObject({ maxFileMB: 10, maxPdfMB: DEFAULT_PREVIEW.maxPdfMB, maxTextMB: DEFAULT_PREVIEW.maxTextMB });
	});

	it('keeps the new limits within their bounds', () => {
		const ok = loadSettings({ schemaVersion: 4, upload: { maxOtherFileMB: 40 }, preview: { maxPdfMB: 100, maxTextMB: 20 } }, emptyDeviceState()).settings;
		expect([ok.upload.maxOtherFileMB, ok.preview.maxPdfMB, ok.preview.maxTextMB]).toEqual([40, 100, 20]);
		const bad = loadSettings({ schemaVersion: 4, upload: { maxOtherFileMB: 101 }, preview: { maxPdfMB: 0, maxTextMB: 21 } }, emptyDeviceState()).settings;
		expect([bad.upload.maxOtherFileMB, bad.preview.maxPdfMB, bad.preview.maxTextMB]).toEqual([100, 50, 5]);
	});

	it('keeps history entries of every attachment format and still drops unknown ones', () => {
		const formats = ['png', 'pdf', 'svg', 'text', 'docx', 'xlsx', 'pptx', 'zip', 'audio', 'video', 'active', 'other'];
		const merged = mergeHistory([...formats.map(entry), entry('bmp')]);
		expect(merged.map((e: HistoryEntry) => e.format).sort()).toEqual([...formats].sort());
	});

	it('is read-only for a newer schema, as Phase 3 is for this one', () => {
		expect(loadSettings({ schemaVersion: 5 }, emptyDeviceState()).readOnly).toBe(true);
	});
});
