import { describe, expect, it } from 'vitest';
import { setLanguage, t, tDynamic } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ja } from '../src/i18n/ja';

describe('i18n', () => {
	it('has a Japanese string for every key', () => {
		expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
	});

	it('follows Obsidian when set to auto', () => {
		setLanguage('auto', 'ja');
		expect(t('modal.run')).toBe(ja['modal.run']);
		setLanguage('auto', 'en');
		expect(t('modal.run')).toBe(en['modal.run']);
	});

	it('fills parameters and falls back for unknown dynamic keys', () => {
		setLanguage('en', 'ja');
		expect(t('modal.title', { alias: 'work' })).toBe('Connection test: work');
		expect(tDynamic('code.no-such-code', 'code.unknown')).toBe(en['code.unknown']);
	});
});
