import { type App, ButtonComponent, Modal } from 'obsidian';
import { t, tDynamic } from '../i18n';
import type { ConfirmChoice } from '../upload/job';
import { canSend, confirmExampleKey, formatBytes, formatKey, type PlanView, type RowStatus, sizeChange } from '../upload/present';

const STATUS_KEY = {
	new: 'upload.status.new',
	history: 'upload.status.history',
	shared: 'upload.status.shared',
	deferred: 'upload.status.deferred',
} as const satisfies Record<RowStatus, string>;

/**
 * 11-2: what will be sent where, and what happens afterwards. Replacing and copying are chosen each time, with
 * no default; closing the screen cancels. In preview mode nothing can be started from here (I13). Design 4-1 and
 * 9-2: a public file of a format that needs confirming is put only if its box is ticked, which is never the default.
 */
export function confirmUpload(app: App, view: PlanView, preview: boolean): Promise<ConfirmChoice | undefined> {
	return new Promise((resolve) => {
		let choice: ConfirmChoice | undefined;
		const confirmed = new Set<string>();
		const sendButtons: ButtonComponent[] = [];
		const refresh = () => {
			for (const b of sendButtons) b.setDisabled(!canSend(view, confirmed));
		};
		new (class extends Modal {
			onOpen(): void {
				this.setTitle(preview ? t('upload.confirm.previewTitle') : t('upload.confirm.title'));
				const el = this.contentEl;
				el.addClass('vault-s3-bridge-upload');

				el.createDiv({ cls: 'vault-s3-bridge-upload-heading', text: t('upload.confirm.connection') });
				el.createEl('p', { text: `${view.alias} · ${view.classification === 'private' ? t('edit.private') : t('edit.public')} · ${view.target.replace(/^aws:/, 'AWS S3 · ').replace(/^s3c:/, '')}` });
				if (view.identifying.length > 0) {
					el.createEl('p', { cls: 'mod-warning', text: `⚠ ${t('upload.confirm.identifying', { vars: view.identifying.map((v) => `{${v}}`).join(' ') })}` });
				}

				el.createDiv({ cls: 'vault-s3-bridge-upload-heading', text: t('upload.confirm.files') });
				if (view.rows.length === 0) el.createEl('p', { text: t('upload.confirm.noFiles') });
				for (const row of view.rows) {
					const box = el.createDiv({ cls: 'vault-s3-bridge-upload-row' });
					box.createDiv({ text: row.sourcePath, cls: 'vault-s3-bridge-upload-path' });
					const meta = box.createDiv({ cls: 'setting-item-description' });
					meta.createSpan({ text: `${t(STATUS_KEY[row.status])} · ${t('upload.confirm.size', { from: formatBytes(row.sourceSize), to: formatBytes(row.sentSize), change: sizeChange(row.sourceSize, row.sentSize) })}` });
					const format = formatKey(row.format);
					if (format) box.createDiv({ cls: 'setting-item-description', text: `${t(format)} · ${row.contentType}` });
					box.createDiv({ cls: 'setting-item-description' }).createEl('code', { text: row.key });
					for (const md of row.markdown) box.createDiv({ cls: 'vault-s3-bridge-upload-markdown' }).createEl('code', { text: md });
					for (const w of row.warnings) box.createDiv({ cls: 'mod-warning', text: `⚠ ${t(w === 'public-copy-remains' ? 'upload.warning.publicCopyRemains' : 'skip.unknown')}` });
					if (row.needsConfirm) {
						box.createDiv({ cls: 'mod-warning', text: `⚠ ${t('upload.confirm.publicWarning')}` });
						box.createDiv({ cls: 'setting-item-description', text: t(confirmExampleKey(row.format)) });
						const label = box.createEl('label');
						const check = label.createEl('input', { type: 'checkbox' });
						label.appendText(` ${t('upload.confirm.publicCheck')}`);
						const note = box.createDiv({ cls: 'setting-item-description', text: t('upload.confirm.reuseOnly') });
						check.disabled = preview;
						check.addEventListener('change', () => {
							if (check.checked) confirmed.add(row.itemId);
							else confirmed.delete(row.itemId);
							note.toggle(!check.checked);
							refresh();
						});
					}
				}
				if (view.sendable) el.createEl('p', { cls: 'setting-item-description', text: t('upload.confirm.total', { size: formatBytes(view.sendBytes) }) });

				if (view.skipped.length > 0) {
					el.createDiv({ cls: 'vault-s3-bridge-upload-heading', text: t('upload.confirm.skipped') });
					const list = el.createEl('ul');
					for (const s of view.skipped) {
						const li = list.createEl('li');
						li.createEl('code', { text: s.original });
						li.appendText(` — ${tDynamic(`skip.${s.reason}`, 'skip.unknown')}`);
					}
				}

				// Kept in view at the bottom of the scrolling modal; the buttons wrap instead of running off the edge.
				const footer = el.createDiv({ cls: 'vault-s3-bridge-upload-footer' });
				if (preview || !view.sendable) {
					new ButtonComponent(footer.createDiv({ cls: 'modal-button-container' })).setButtonText(t('modal.close')).onClick(() => this.close());
					return;
				}
				footer.createDiv({ cls: 'setting-item-name', text: t('upload.confirm.afterwards') });
				footer.createDiv({ cls: 'setting-item-description', text: t('upload.confirm.copyDesc') });
				const buttons = footer.createDiv({ cls: 'modal-button-container' });
				// Neither is the default: no call-to-action styling, and nothing is chosen by Enter.
				new ButtonComponent(buttons).setButtonText(t('modal.cancel')).onClick(() => this.close());
				const copy = new ButtonComponent(buttons).setButtonText(t('upload.confirm.copy')).onClick(() => {
					choice = { apply: 'copy', confirmed: [...confirmed] };
					this.close();
				});
				const replace = new ButtonComponent(buttons).setButtonText(t('upload.confirm.replace')).onClick(() => {
					choice = { apply: 'replace', confirmed: [...confirmed] };
					this.close();
				});
				sendButtons.push(copy, replace);
				refresh();
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(choice);
			}
		})(app).open();
	});
}
