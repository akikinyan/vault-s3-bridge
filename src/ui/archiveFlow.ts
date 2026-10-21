// Design 8-7 and 8-8: the archive command with its confirmation screen and result notice, and the screen that
// moves archived files back.
import { type App, type ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import { type ArchivePlan, type ArchiveStop, archiveCommand, type ExcludedReason } from '../archive/archive';
import { archiveCommandDeps, archiveVault } from '../archive/obsidianArchive';
import { ARCHIVE_FOLDER } from '../archive/paths';
import { archivedFiles, restoreFiles } from '../archive/restore';
import { t, type MessageKey } from '../i18n';
import type { UploadHost } from '../upload/obsidianJob';
import { formatBytes } from '../upload/present';

const EXCLUDED_KEY: Record<ExcludedReason | 'referenced', MessageKey> = {
	referenced: 'archive.excluded.referenced',
	'same-name': 'archive.excluded.same-name',
	'too-large': 'archive.excluded.too-large',
	unreadable: 'archive.excluded.unreadable',
	'not-in-history': 'archive.excluded.not-in-history',
	'not-on-storage': 'archive.excluded.not-on-storage',
	unverified: 'archive.excluded.unverified',
};

function excludedLines(excluded: ArchivePlan['excluded']): string[] {
	return (Object.keys(EXCLUDED_KEY) as (keyof typeof EXCLUDED_KEY)[]).flatMap((r) => (excluded[r] ? [t(EXCLUDED_KEY[r], { n: String(excluded[r]) })] : []));
}

/** A list of files with a box each (never ticked by default) and "select all"; the action needs one ticked. */
function checklist(el: HTMLElement, rows: readonly { path: string; render(box: HTMLElement): void }[], chosen: Set<string>, onChange: () => void): void {
	const checks: HTMLInputElement[] = [];
	new Setting(el).addButton((b) =>
		b.setButtonText(t('archive.confirm.selectAll')).onClick(() => {
			for (const [i, c] of checks.entries()) {
				c.checked = true;
				chosen.add(rows[i]!.path);
			}
			onChange();
		}),
	);
	for (const row of rows) {
		const box = el.createDiv({ cls: 'vault-s3-bridge-upload-row' });
		const label = box.createEl('label', { cls: 'vault-s3-bridge-upload-path' });
		const check = label.createEl('input', { type: 'checkbox' });
		label.appendText(` ${row.path}`);
		checks.push(check);
		check.addEventListener('change', () => {
			if (check.checked) chosen.add(row.path);
			else chosen.delete(row.path);
			onChange();
		});
		row.render(box);
	}
}

/** Design 8-7: the files, their size and object; nothing is chosen by default; closing cancels. */
function confirmArchive(app: App, plan: ArchivePlan): Promise<readonly string[] | undefined> {
	return new Promise((resolve) => {
		let result: string[] | undefined;
		const chosen = new Set<string>();
		let move: ButtonComponent | undefined;
		new (class extends Modal {
			onOpen(): void {
				this.setTitle(t('archive.confirm.title'));
				const el = this.contentEl;
				el.addClass('vault-s3-bridge-upload');
				el.createEl('p', { text: t('archive.confirm.intro', { folder: ARCHIVE_FOLDER }) });
				el.createEl('p', { cls: 'mod-warning', text: `⚠ ${t('archive.confirm.limits')}` });
				const rows = plan.candidates.map((c) => ({
					path: c.path,
					render: (box: HTMLElement) => {
						box.createDiv({ cls: 'setting-item-description', text: formatBytes(c.size) });
						const object = box.createDiv({ cls: 'setting-item-description' });
						object.appendText(`${c.alias} · `);
						object.createEl('code', { text: c.key });
						if (c.converted) box.createDiv({ cls: 'setting-item-description', text: t('archive.confirm.converted') });
					},
				}));
				checklist(el, rows, chosen, () => {
					move?.setDisabled(chosen.size === 0);
				});
				const lines = excludedLines(plan.excluded);
				if (lines.length > 0) {
					el.createEl('h4', { text: t('archive.confirm.excluded') });
					const list = el.createEl('ul');
					for (const line of lines) list.createEl('li', { text: line });
				}
				new Setting(el)
					.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
					.addButton((b) => {
						move = b;
						b.setButtonText(t('archive.confirm.move'))
							.setDisabled(true)
							.onClick(() => {
								result = [...chosen];
								this.close();
							});
					});
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(result);
			}
		})(app).open();
	});
}

function stopMessage(r: ArchiveStop): string | undefined {
	switch (r.stop) {
		case 'cancelled':
			return undefined;
		case 'foreign-folder':
			return t('archive.stop.foreign-folder', { folder: ARCHIVE_FOLDER });
		case 'marker':
			return t(r.state === 'newer' ? 'archive.stop.marker-newer' : 'archive.stop.marker-invalid');
		case 'incomplete':
			return t(`archive.stop.incomplete-${r.reason}`, { path: r.path });
		case 'auth':
			return t('archive.stop.auth', { reason: t(`code.${r.category}`) });
		case 'nothing':
			return [t('archive.stop.nothing'), ...excludedLines(r.excluded)].join('\n');
		default:
			return t(`archive.stop.${r.stop}`);
	}
}

/** The archive command (8-2): a notice while references are collected, the screen, then the result. */
export async function runArchiveCommand(host: UploadHost): Promise<void> {
	const vault = archiveVault(host.app);
	if (!vault) {
		new Notice(t('archive.noAdapter'));
		return;
	}
	const stop = new AbortController();
	const scanning = new Notice(t('archive.scanning'), 0);
	const job = archiveCommandDeps(host, vault, {
		confirm: (plan) => {
			scanning.hide();
			return confirmArchive(host.app, plan);
		},
		stop: stop.signal,
	});
	try {
		const r = await archiveCommand(job.deps);
		scanning.hide();
		if ('stop' in r) {
			const message = stopMessage(r);
			if (message) new Notice(message, r.stop === 'nothing' ? 0 : undefined);
			return;
		}
		const { moved, stopped, notTried } = r.done;
		const lines = [t('archive.result.moved', { n: String(moved.length), folder: ARCHIVE_FOLDER })];
		if (stopped) lines.push(t('archive.result.stopped', { path: stopped.path, reason: t(`archive.move.${stopped.reason}`), n: String(notTried.length) }));
		if (moved.length > 0) lines.push(t('archive.result.undo'));
		new Notice(lines.join('\n'), stopped ? 0 : undefined);
	} catch {
		new Notice(t('code.unknown'));
	} finally {
		scanning.hide();
		job.dispose();
	}
}

/** Design 8-8: archived files to choose from; the chosen ones go back where they were. */
export function openRestore(host: Pick<UploadHost, 'app' | 'lock'>): void {
	const vault = archiveVault(host.app);
	if (!vault) {
		new Notice(t('archive.noAdapter'));
		return;
	}
	const files = archivedFiles(vault);
	new (class extends Modal {
		onOpen(): void {
			this.setTitle(t('restore.title'));
			const el = this.contentEl;
			el.addClass('vault-s3-bridge-upload');
			if (files.length === 0) {
				el.createEl('p', { text: t('restore.empty') });
				return;
			}
			el.createEl('p', { cls: 'setting-item-description', text: t('restore.intro') });
			const chosen = new Set<string>();
			let move: ButtonComponent | undefined;
			const rows = files.map((f) => ({
				path: f.path,
				render: (box: HTMLElement) => {
					box.createDiv({ cls: 'setting-item-description', text: `→ ${f.restoreTo} · ${formatBytes(f.size)}` });
				},
			}));
			checklist(el, rows, chosen, () => {
				move?.setDisabled(chosen.size === 0);
			});
			new Setting(el)
				.addButton((b) => b.setButtonText(t('modal.cancel')).onClick(() => this.close()))
				.addButton((b) => {
					move = b;
					b.setButtonText(t('restore.move'))
						.setDisabled(true)
						.onClick(() => {
							this.close();
							void restore([...chosen]);
						});
				});
		}

		onClose(): void {
			this.contentEl.empty();
		}
	})(host.app).open();

	async function restore(paths: string[]): Promise<void> {
		const r = await restoreFiles(host.lock, vault!, paths);
		if ('stop' in r) {
			if (r.stop === 'busy') new Notice(t('archive.stop.busy'));
			else if (r.state === 'absent') new Notice(t('restore.stop.absent'));
			else if (r.state === 'foreign') new Notice(t('archive.stop.foreign-folder', { folder: ARCHIVE_FOLDER }));
			else new Notice(t(r.state === 'newer' ? 'archive.stop.marker-newer' : 'archive.stop.marker-invalid'));
			return;
		}
		const lines = [t('restore.result', { n: String(r.restored.length) }), ...r.skipped.map((s) => t(`restore.skipped.${s.reason}`, { path: s.path }))];
		new Notice(lines.join('\n'), r.skipped.length > 0 ? 0 : undefined);
	}
}
