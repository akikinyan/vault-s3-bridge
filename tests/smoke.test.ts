import { describe, expect, it } from 'vitest';
import VaultS3BridgePlugin from '../src/main';

describe('plugin entry point', () => {
	it('exports the plugin class', () => {
		expect(typeof VaultS3BridgePlugin).toBe('function');
	});
});
