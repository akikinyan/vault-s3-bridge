import { type App, type Editor, type MarkdownFileInfo, MarkdownView, Modal, Notice, Setting } from 'obsidian';
import { t, tDynamic } from '../i18n';
import { PreviewError } from '../preview/errors';
import { checkKey, formatReference, referenceMarkdown } from '../reference/reference';
import { connectionState } from '../settings/registry';
import type { StorageConnection } from '../settings/types';
import type VaultS3BridgePlugin from '../main';

/** Snapshot of where the reference will be inserted. */
interface Target {
	editor: Editor;
	path: string | undefined;
	cursor: { line: number; ch: number };
	content: string;
}

export function snapshot(editor: Editor, path: string | undefined): Target {
	return { editor, path, cursor: editor.getCursor(), content: editor.getValue() };
}

/** True when the same editor still shows the same, unchanged note. */
export function stillSame(target: Target, editor: Editor | undefined, path: string | undefined): boolean {
	return (
		editor === target.editor &&
		path === target.path &&
		editor.getValue() === target.content &&
		editor.getCursor().line === target.cursor.line &&
		editor.getCursor().ch === target.cursor.ch
	);
}

export class InsertReferenceModal extends Modal {
	private connectionId: string | undefined;
	private key = '';
	private busy = false;
	private controller: AbortController | undefined;
	private statusEl!: HTMLElement;
	private readonly path: string | undefined;

	constructor(
		app: App,
		private readonly plugin: VaultS3BridgePlugin,
		private readonly editor: Editor,
		view: MarkdownView | MarkdownFileInfo,
	) {
		super(app);
		this.path = view.file?.path;
	}

	private usable(): StorageConnection[] {
		const s = this.plugin.settings;
		return s.connections.filter(
			(c) => c.classification === 'private' && connectionState(s, c) === 'active' && this.plugin.profileFor(c.id) !== undefined,
		);
	}

	onOpen(): void {
		this.setTitle(t('insert.title'));
		const connections = this.usable();
		if (connections.length === 0) {
			this.contentEl.createEl('p', { text: t('insert.noPrivateConnections') });
			return;
		}
		this.connectionId = connections[0]?.id;
		new Setting(this.contentEl).setName(t('insert.connection')).addDropdown((d) => {
			for (const c of connections) d.addOption(c.id, `${c.alias} (${c.bucket})`);
			d.setValue(this.connectionId ?? '').onChange((v) => (this.connectionId = v));
		});
		new Setting(this.contentEl)
			.setName(t('insert.key'))
			.setDesc(t('insert.keyDesc'))
			.addText((text) => {
				text.onChange((v) => (this.key = v.trim()));
				text.inputEl.addEventListener('keydown', (e) => {
					if (e.key === 'Enter') void this.submit();
				});
			});
		new Setting(this.contentEl).addButton((b) => b.setButtonText(t('insert.insert')).setCta().onClick(() => void this.submit()));
		this.statusEl = this.contentEl.createEl('p', { cls: 'setting-item-description' });
	}

	onClose(): void {
		// Closing the dialog while checking cancels the insertion.
		this.controller?.abort();
		this.contentEl.empty();
	}

	private async submit(): Promise<void> {
		if (this.busy) return;
		const connection = this.plugin.settings.connections.find((c) => c.id === this.connectionId);
		if (!connection) return;
		if (checkKey(this.key)) {
			this.statusEl.setText(t('insert.invalidKey'));
			return;
		}
		const markdown = referenceMarkdown(connection.alias, this.key);
		const target = snapshot(this.editor, this.path);
		this.busy = true;
		this.statusEl.setText(t('insert.checking'));
		const controller = new AbortController();
		this.controller = controller;
		try {
			await this.plugin.preview.exists(formatReference(connection.alias, this.key), controller.signal);
		} catch (error) {
			if (controller.signal.aborted) return;
			const code = error instanceof PreviewError ? error.code : 'unknown';
			this.statusEl.setText(t('insert.failed', { reason: tDynamic(`preview.${code}`, 'preview.unknown') }));
			this.busy = false;
			return;
		}
		this.busy = false;
		if (controller.signal.aborted) return;
		this.controller = undefined;
		this.close();
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && stillSame(target, view.editor, view.file?.path)) {
			view.editor.replaceRange(markdown, target.cursor);
			return;
		}
		// The note changed while checking: never insert into an unexpected place.
		const fragment = createFragment((f) => {
			f.createDiv({ text: t('insert.changed') });
			const button = f.createEl('button', { text: t('insert.copy') });
			button.addEventListener('click', () => {
				void navigator.clipboard.writeText(markdown).then(() => new Notice(t('insert.copied')));
			});
		});
		new Notice(fragment, 0);
	}
}
