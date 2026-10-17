import { type App, ButtonComponent, Modal, Notice, Setting } from 'obsidian';
import { runConnectionTest } from '../diagnostics/connectionTest';
import type { DiagnosticItem, DiagnosticReport } from '../diagnostics/types';
import { TEST_PREFIX } from '../diagnostics/writeTest';
import { t, tDynamic, type MessageKey } from '../i18n';
import type { NetworkSettings, StorageConnection } from '../settings/types';
import { validatePublicBaseUrl } from '../settings/validate';
import { testButton } from './testButton';

const STATUS_ICON: Record<DiagnosticItem['status'], string> = {
	success: '✅',
	fail: '❌',
	warn: '⚠️',
	unverified: '❔',
	skipped: '⏭️',
};

export class ConnectionTestModal extends Modal {
	private writeTest = false;
	private controller: AbortController | undefined;
	private running = false;
	private closed = false;
	private resultsEl!: HTMLElement;
	private runButton!: ButtonComponent;
	private secondaryButton!: ButtonComponent;

	constructor(
		app: App,
		private readonly connection: StorageConnection,
		private readonly network: NetworkSettings,
		private readonly profile: string | undefined,
	) {
		super(app);
	}

	onOpen(): void {
		this.closed = false;
		const { contentEl } = this;
		this.setTitle(t('modal.title', { alias: this.connection.alias }));
		new Setting(contentEl)
			.setName(t('modal.writeTest'))
			.setDesc(t('modal.writeTestDesc', { prefix: TEST_PREFIX }))
			.addToggle((toggle) => toggle.setValue(this.writeTest).onChange((v) => (this.writeTest = v)));
		new Setting(contentEl)
			.addButton((b) => {
				this.secondaryButton = b;
				b.onClick(() => {
					if (testButton(this.running).action === 'abort') this.controller?.abort();
					else this.close();
				});
			})
			.addButton((b) => {
				this.runButton = b;
				b.setButtonText(t('modal.run'))
					.setCta()
					.onClick(() => void this.run());
			});
		this.resultsEl = contentEl.createDiv({ cls: 'vault-s3-bridge-results' });
		this.updateSecondaryButton();
	}

	private updateSecondaryButton(): void {
		this.secondaryButton.setButtonText(t(testButton(this.running).label));
	}

	onClose(): void {
		this.closed = true;
		// Cancel a running test; cleanup still runs and is reported by a notice if needed.
		this.controller?.abort();
		this.contentEl.empty();
	}

	private async run(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.controller = new AbortController();
		this.runButton.setDisabled(true);
		this.updateSecondaryButton();
		this.resultsEl.empty();
		this.resultsEl.createEl('p', { text: t('modal.running') });
		try {
			const report = await runConnectionTest(this.connection, {
				profile: this.profile,
				network: this.network,
				writeTest: this.writeTest,
				signal: this.controller.signal,
				onProgress: (items) => this.renderItems(items),
			});
			if (this.closed) this.noticeLeftover(report);
			else this.renderReport(report);
		} finally {
			this.running = false;
			this.controller = undefined;
			if (!this.closed) {
				this.runButton.setDisabled(false);
				this.updateSecondaryButton();
			}
		}
	}

	private renderItems(items: readonly DiagnosticItem[]): void {
		if (this.closed) return;
		this.resultsEl.empty();
		const list = this.resultsEl.createEl('ul', { cls: 'vault-s3-bridge-items' });
		for (const item of items) {
			const li = list.createEl('li', { cls: `vault-s3-bridge-item is-${item.status}` });
			li.createSpan({ text: `${STATUS_ICON[item.status]} ` });
			li.createSpan({ cls: 'vault-s3-bridge-item-name', text: t(`item.${item.id}` as MessageKey) });
			li.createSpan({ text: ` — ${t(`status.${item.status}` as MessageKey)}` });
			if (item.code) li.createDiv({ cls: 'vault-s3-bridge-item-detail', text: tDynamic(`code.${item.code}`, 'code.unknown') });
			for (const [key, value] of Object.entries(item.data ?? {})) {
				li.createDiv({ cls: 'vault-s3-bridge-item-detail', text: `${tDynamic(`data.${key}`, 'code.unknown')}: ${value}` });
			}
			if (item.id === 'bucket' && item.status === 'success') {
				li.createDiv({ cls: 'vault-s3-bridge-item-detail', text: t('modal.headBucketNote') });
			}
		}
	}

	private renderReport(report: DiagnosticReport): void {
		this.renderItems(report.items);
		// Plan 2-8: the same item as in the connection editor. Not a test of the storage itself.
		const c = this.connection;
		if (c.classification === 'public' && (c.publicBaseUrl === undefined || validatePublicBaseUrl(c.publicBaseUrl))) {
			this.resultsEl.createEl('p', { cls: 'mod-warning', text: `⚠ ${t('edit.publicBaseUrlNeeded')}` });
		}
		if (report.aborted) this.resultsEl.createEl('p', { cls: 'vault-s3-bridge-aborted', text: t('modal.aborted') });
		const command = report.ssoLoginCommand;
		if (command) {
			const box = this.resultsEl.createDiv({ cls: 'vault-s3-bridge-sso' });
			box.createEl('p', { text: t('modal.ssoLogin') });
			box.createEl('code', { text: command });
			new Setting(box).addButton((b) =>
				b.setButtonText(t('modal.copy')).onClick(async () => {
					await navigator.clipboard.writeText(command);
					new Notice(t('modal.copied'));
				}),
			);
		}
	}

	/** The modal was closed while running: surface a cleanup problem instead of hiding it. */
	private noticeLeftover(report: DiagnosticReport): void {
		const cleanup = report.items.find((i) => i.id === 'cleanup');
		if (!cleanup || cleanup.status === 'success') return;
		const detail = Object.entries(cleanup.data ?? {})
			.map(([k, v]) => `${tDynamic(`data.${k}`, 'code.unknown')}: ${v}`)
			.join('\n');
		new Notice(`${t('item.cleanup')}: ${tDynamic(`code.${cleanup.code ?? 'unknown'}`, 'code.unknown')}\n${detail}`, 0);
	}
}
