// Record operations from the settings tab (7-4, 7-5): resume, copy, discard, take over, reset. Each takes the
// job lock (7-6) and tells the outcome in a notice.
import { type App, Modal, Notice, Setting } from 'obsidian';
import { t } from '../i18n';
import { copyDelivered, recordMarkdown, resumeCommand, type ResumeTarget, withLock } from '../upload/job';
import { copyToClipboard, resumeCommandDeps, type UploadHost } from '../upload/obsidianJob';
import type { PendingItem, PendingResult, PendingStore } from '../upload/pending';
import { copyLines, type Line, resumeLines } from '../upload/present';
import type { DeepReadonly } from '../util/deepReadonly';
import { confirm } from './ConfirmModal';

const notify = (lines: readonly Line[]) => {
	if (lines.length > 0) new Notice(lines.map((l) => t(l.key, l.params)).join('\n'));
};

/** I13: the files, keys and Markdown of every group about to be resumed. */
function confirmResume(app: App, targets: readonly ResumeTarget[], items: DeepReadonly<PendingItem[]>, mismatched: number): Promise<boolean> {
	return new Promise((resolve) => {
		let ok = false;
		new (class extends Modal {
			onOpen(): void {
				this.setTitle(t('pending.resume.title'));
				const el = this.contentEl;
				el.createEl('p', { cls: 'setting-item-description', text: t('pending.resume.desc') });
				for (const target of targets) {
					const c = target.connection;
					el.createEl('h4', { text: `${c.alias} · ${c.classification === 'private' ? t('edit.private') : t('edit.public')} · ${c.bucket}` });
					for (const id of target.groups.flat()) {
						const item = items.find((i) => i.id === id);
						if (!item) continue;
						const box = el.createDiv();
						box.createDiv({ text: item.sourcePath });
						box.createDiv({ cls: 'setting-item-description' }).createEl('code', { text: item.altKey ?? item.key });
						for (const md of recordMarkdown(item, c) ?? []) box.createDiv().createEl('code', { text: md });
					}
				}
				if (mismatched > 0) el.createEl('p', { cls: 'mod-warning', text: t('pending.resume.mismatched', { n: String(mismatched) }) });
				new Setting(el)
					.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
					.addButton((b) =>
						b
							.setButtonText(t('pending.resume.run'))
							.setCta()
							.onClick(() => {
								ok = true;
								this.close();
							}),
					);
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(ok);
			}
		})(app).open();
	});
}

export async function resumeRecords(host: UploadHost, pending: PendingStore): Promise<void> {
	const job = resumeCommandDeps(host, pending, {
		confirm: (targets, mismatched) => confirmResume(host.app, targets, pending.items, mismatched),
		// Resuming stops with the plugin; its own progress is the notice that follows.
		stop: new AbortController().signal,
	});
	try {
		notify(resumeLines(await resumeCommand(job.deps)));
	} catch {
		new Notice(t('code.unknown'));
	} finally {
		job.dispose();
	}
}

export async function copyRecords(host: UploadHost, pending: PendingStore): Promise<void> {
	notify(copyLines(await copyDelivered({ lock: host.lock, pending, settings: host.store, copy: copyToClipboard })));
}

async function locked(host: UploadHost, op: () => Promise<PendingResult>): Promise<void> {
	const r = await withLock(host.lock, op);
	if (r === 'busy') new Notice(t('upload.stop.busy'));
	else if (!r.ok) new Notice(t('pending.opFailed'));
}

export async function discardRecord(host: UploadHost, pending: PendingStore, item: DeepReadonly<PendingItem>): Promise<void> {
	if (!(await confirm(host.app, t('settings.pendingDiscardConfirm', { path: item.sourcePath }), t('settings.pendingDiscard')))) return;
	await locked(host, () => pending.removeDiscarded([item.id]));
}

export async function resetDamagedRecords(host: UploadHost, pending: PendingStore): Promise<void> {
	if (!(await confirm(host.app, t('settings.pendingResetConfirm'), t('settings.pendingReset')))) return;
	await locked(host, () => pending.resetDamaged());
}

export async function takeOverRecords(host: UploadHost, pending: PendingStore, deviceId: string): Promise<void> {
	await locked(host, () => pending.takeOver(deviceId));
}

export async function discardOtherRecords(host: UploadHost, pending: PendingStore, deviceId: string): Promise<void> {
	if (!(await confirm(host.app, t('settings.pendingOtherDiscardConfirm'), t('settings.pendingOtherDiscard')))) return;
	await locked(host, () => pending.discardOther(deviceId));
}
