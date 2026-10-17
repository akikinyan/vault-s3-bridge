import type { MessageKey } from '../i18n';

/** The secondary button of the connection test: closes the dialog when idle, stops the test while it runs. */
export function testButton(running: boolean): { label: MessageKey; action: 'close' | 'abort' } {
	return running ? { label: 'modal.stop', action: 'abort' } : { label: 'modal.close', action: 'close' };
}
