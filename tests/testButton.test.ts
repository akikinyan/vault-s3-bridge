import { describe, expect, it } from 'vitest';
import { setLanguage, t } from '../src/i18n';
import { testButton } from '../src/ui/testButton';

describe('connection test: secondary button', () => {
	it('closes the dialog when no test runs, and stops the test while one runs', () => {
		expect(testButton(false)).toEqual({ label: 'modal.close', action: 'close' });
		expect(testButton(true)).toEqual({ label: 'modal.stop', action: 'abort' });
	});

	it('has a label in both languages', () => {
		setLanguage('ja', 'ja');
		expect([t(testButton(false).label), t(testButton(true).label)]).toEqual(['閉じる', 'テストを中断']);
		setLanguage('en', 'en');
		expect([t(testButton(false).label), t(testButton(true).label)]).toEqual(['Close', 'Stop test']);
	});
});
