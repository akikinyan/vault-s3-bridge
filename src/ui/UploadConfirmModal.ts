import { type App, Modal, Setting } from 'obsidian';
import { t, tDynamic } from '../i18n';
import { formatBytes, type PlanView, type RowStatus } from '../upload/present';

const STATUS_KEY = {
	new: 'upload.status.new',
	history: 'upload.status.history',
	shared: 'upload.status.shared',
	deferred: 'upload.status.deferred',
} as const satisfies Record<RowStatus, string>;

/**
 * 11-2: what will be sent where, and what happens afterwards. Replacing and copying are chosen each time, with
 * no default; closing the screen cancels. In preview mode nothing can be started from here (I13).
 */
export function confirmUpload(app: App, view: PlanView, preview: boolean): Promise<'replace' | 'copy' | undefined> {
	return new Promise((resolve) => {
		let choice: 'replace' | 'copy' | undefined;
		new (class extends Modal {
			onOpen(): void {
				this.setTitle(preview ? t('upload.confirm.previewTitle') : t('upload.confirm.title'));
				const el = this.contentEl;
				el.addClass('vault-s3-bridge-upload');

				el.createEl('h4', { text: t('upload.confirm.connection') });
				el.createEl('p', { text: `${view.alias} · ${view.classification === 'private' ? t('edit.private') : t('edit.public')} · ${view.target.replace(/^aws:/, 'AWS S3 · ').replace(/^s3c:/, '')}` });
				if (view.identifying.length > 0) {
					el.createEl('p', { cls: 'mod-warning', text: `⚠ ${t('upload.confirm.identifying', { vars: view.identifying.map((v) => `{${v}}`).join(' ') })}` });
				}

				el.createEl('h4', { text: t('upload.confirm.files') });
				if (view.rows.length === 0) el.createEl('p', { text: t('upload.confirm.noFiles') });
				for (const row of view.rows) {
					const box = el.createDiv({ cls: 'vault-s3-bridge-upload-row' });
					box.createDiv({ text: row.sourcePath, cls: 'vault-s3-bridge-upload-path' });
					const meta = box.createDiv({ cls: 'setting-item-description' });
					meta.createSpan({ text: `${t(STATUS_KEY[row.status])} · ${t('upload.confirm.size', { from: formatBytes(row.sourceSize), to: formatBytes(row.sentSize) })}` });
					box.createDiv({ cls: 'setting-item-description' }).createEl('code', { text: row.key });
					for (const md of row.markdown) box.createDiv().createEl('code', { text: md });
					for (const w of row.warnings) box.createDiv({ cls: 'mod-warning', text: `⚠ ${t(w === 'public-copy-remains' ? 'upload.warning.publicCopyRemains' : 'skip.unknown')}` });
				}
				if (view.sendable) el.createEl('p', { cls: 'setting-item-description', text: t('upload.confirm.total', { size: formatBytes(view.sendBytes) }) });

				if (view.skipped.length > 0) {
					el.createEl('h4', { text: t('upload.confirm.skipped') });
					const list = el.createEl('ul');
					for (const s of view.skipped) {
						const li = list.createEl('li');
						li.createEl('code', { text: s.original });
						li.appendText(` — ${tDynamic(`skip.${s.reason}`, 'skip.unknown')}`);
					}
				}

				const buttons = new Setting(el);
				if (preview || !view.sendable) {
					buttons.addButton((b) => b.setButtonText(t('modal.close')).onClick(() => this.close()));
					return;
				}
				buttons.setName(t('upload.confirm.afterwards')).setDesc(t('upload.confirm.copyDesc'));
				// Neither is the default: no call-to-action styling, and nothing is chosen by Enter.
				buttons
					.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
					.addButton((b) =>
						b.setButtonText(t('upload.confirm.copy')).onClick(() => {
							choice = 'copy';
							this.close();
						}),
					)
					.addButton((b) =>
						b.setButtonText(t('upload.confirm.replace')).onClick(() => {
							choice = 'replace';
							this.close();
						}),
					);
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(choice);
			}
		})(app).open();
	});
}
