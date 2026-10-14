import { type App, Modal, Setting } from 'obsidian';
import { t } from '../i18n';

/** Resolves to true only when the user explicitly confirms. */
export function confirm(app: App, message: string, confirmLabel: string): Promise<boolean> {
	return new Promise((resolve) => {
		let confirmed = false;
		const modal = new (class extends Modal {
			onOpen(): void {
				this.contentEl.createEl('p', { text: message });
				new Setting(this.contentEl)
					.addButton((b) =>
						b.setButtonText(t('modal.cancel')).onClick(() => this.close()),
					)
					.addButton((b) =>
						b
							.setButtonText(confirmLabel)
							.setDestructive()
							.onClick(() => {
								confirmed = true;
								this.close();
							}),
					);
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(confirmed);
			}
		})(app);
		modal.open();
	});
}
