import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type VaultS3BridgePlugin from '../src/main';
import { VaultS3BridgeSettingTab } from '../src/settings/SettingTab';

function tab() {
	const setField = vi.fn(async () => true);
	const plugin = { setField, scheduleRecreatePreview: vi.fn() } as unknown as VaultS3BridgePlugin;
	return { setField, tab: new VaultS3BridgeSettingTab({} as never, plugin) };
}

describe('setting tab text fields', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal('window', globalThis);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('saves the proxy URL once typing pauses', async () => {
		const { setField, tab: t } = tab();
		await t.setControlValue('proxyUrl', 'http://proxy.example.com:8080');
		expect(setField).not.toHaveBeenCalled();
		await vi.runAllTimersAsync();
		expect(setField).toHaveBeenCalledWith('proxyUrl', 'http://proxy.example.com:8080');
	});

	it('drops the queued URL when the text becomes invalid before the pause', async () => {
		const { setField, tab: t } = tab();
		await t.setControlValue('proxyUrl', 'http://proxy.example.com:8080');
		await t.setControlValue('proxyUrl', 'http://user:secret@proxy.example.com:8080');
		await vi.runAllTimersAsync();
		expect(setField).not.toHaveBeenCalled();
	});

	it('does not save the earlier URL when the tab closes on invalid text', async () => {
		const { setField, tab: t } = tab();
		await t.setControlValue('proxyUrl', 'http://proxy.example.com:8080');
		await t.setControlValue('proxyUrl', 'not a url');
		t.flushPendingText();
		await vi.runAllTimersAsync();
		expect(setField).not.toHaveBeenCalled();
	});
});
