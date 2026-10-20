import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { join } from 'node:path';
import { FileSystemAdapter, getLanguage, MarkdownRenderChild, Notice, Plugin } from 'obsidian';
import { setLanguage, t, type MessageKey } from './i18n';
import { type CommandRegistry, guardLinkCommands, LinkGuard, s3LinkAt } from './preview/linkGuard';
import { livePreviewExtension } from './preview/livePreview';
import { renderPlaceholder } from './preview/placeholder';
import { ImageReplacer } from './preview/replacer';
import type { PreviewService } from './preview/service';
import { createPreviewStack } from './preview/stack';
import { profileOf, type DeviceState, type DeviceStorage } from './settings/device';
import { deleteConnectionOp, resetOp, resolveConflictOp, saveConnectionOp, setFieldOp, type FieldKey } from './settings/ops';
import { connectionState } from './settings/registry';
import { VaultS3BridgeSettingTab } from './settings/SettingTab';
import { SettingsStore, type MutateResult, type ReadOnlyReason } from './settings/store';
import type { PluginSettings, StorageConnection } from './settings/types';
import { readJsonFile, writeFileAtomic } from './util/atomicFile';
import type { DeepReadonly } from './util/deepReadonly';
import { JobLock } from './upload/job';
import type { UploadHost } from './upload/obsidianJob';
import { nodePendingIO, PendingStore } from './upload/pending';
import { ConnectionPickerModal } from './ui/ConnectionPickerModal';
import { ConnectionTestModal } from './ui/ConnectionTestModal';
import { editTarget, InsertReferenceModal } from './ui/InsertReferenceModal';
import { PreviewModal } from './ui/PreviewModal';
import { runUploadCommand, uploadTarget } from './ui/uploadFlow';

const SWEEP_INTERVAL_MS = 30_000;

/** Releases the previews of a rendered Markdown section when Obsidian unloads it. */
class PreviewChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly replacer: ImageReplacer,
	) {
		super(containerEl);
	}

	onunload(): void {
		this.replacer.releaseTree(this.containerEl);
	}
}

export default class VaultS3BridgePlugin extends Plugin {
	/** The only place settings are read, changed and saved. */
	store!: SettingsStore;
	/** Always the store's current settings (updated synchronously by the store's notification). */
	settings!: DeepReadonly<PluginSettings>;
	preview!: PreviewService;
	private handler!: NodeHttpHandler;
	private replacer!: ImageReplacer;
	private settingTab?: VaultS3BridgeSettingTab;
	private readonly insertModals = new Set<InsertReferenceModal>();
	/** Upload resume records of this device; undefined where the plugin folder is not on the file system. */
	pending: PendingStore | undefined;
	/** I8: one upload, resume, takeover or discard at a time. */
	readonly lock = new JobLock();
	private readonly unloading = new AbortController();

	private readonly deviceStorage: DeviceStorage = {
		load: (key) => this.app.loadLocalStorage(key) as unknown,
		save: (key, data) => this.app.saveLocalStorage(key, data),
	};

	get device(): DeepReadonly<DeviceState> {
		return this.store.device;
	}

	/** Set when data.json was written by a newer schema or cannot be read; nothing is saved over it. */
	get readOnly(): ReadOnlyReason | undefined {
		return this.store.readOnly;
	}

	async onload(): Promise<void> {
		this.store = new SettingsStore({
			loadData: () => this.loadData() as Promise<unknown>,
			saveData: (data) => this.saveData(data),
			device: this.deviceStorage,
			sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
			privateFilesBackup: this.pluginFile('private-files.json', (path) => ({
				read: () => readJsonFile(path),
				write: (hashes) => writeFileAtomic(path, JSON.stringify({ version: 1, privateFiles: hashes })),
			})),
		});
		this.settings = this.store.current;
		this.register(
			this.store.subscribe(() => {
				this.settings = this.store.current;
				setLanguage(this.settings.language, getLanguage());
			}),
		);
		await this.store.reload();
		setLanguage(this.settings.language, getLanguage());
		this.pending = this.pluginFile('.', (dir) => new PendingStore(nodePendingIO(dir), this.store.device.deviceId));
		await this.pending?.load();
		this.createPreview();
		this.replacer = new ImageReplacer(() => this.preview, renderPlaceholder);

		this.registerMarkdownPostProcessor((el, ctx) => {
			this.replacer.processTree(el);
			if (el.querySelector('img[data-s3-bridge-ref]')) ctx.addChild(new PreviewChild(el, this.replacer));
		});
		this.registerEditorExtension(livePreviewExtension(this.replacer));
		this.registerInterval(window.setInterval(() => this.replacer.sweep(), SWEEP_INTERVAL_MS));
		this.guardLinks();

		this.settingTab = new VaultS3BridgeSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addCommand({ id: 'test-connection', name: t('command.testConnection'), callback: () => this.testConnection() });
		this.addCommand({
			id: 'insert-private-reference',
			name: t('command.insertReference'),
			// A plain callback keeps the command listed in reading mode, where it explains what to do.
			callback: () => this.insertReference(),
		});
		this.addCommand({ id: 'upload-current-note', name: t('command.upload'), callback: () => void this.upload(false) });
		this.addCommand({ id: 'preview-upload', name: t('command.previewUpload'), callback: () => void this.upload(true) });
	}

	/**
	 * Design 7-5: `s3-bridge:` links open the preview modal, never anything outside Obsidian. Every window is
	 * guarded, including popouts already open when the plugin loads; everything is put back on unload.
	 */
	private guardLinks(): void {
		const openPreview = (url: string) => new PreviewModal(this.app, url, () => this.preview).open();
		const guard = new LinkGuard({ openPreview });
		this.register(() => guard.dispose());
		guard.install(window);
		const installAll = () =>
			this.app.workspace.iterateAllLeaves((leaf) => {
				guard.install(leaf.view.containerEl.win);
			});
		installAll();
		this.app.workspace.onLayoutReady(installAll);
		this.registerEvent(this.app.workspace.on('window-open', (w) => guard.install(w.win)));
		this.registerEvent(this.app.workspace.on('window-close', (w) => guard.uninstall(w.win)));
		// Layer 2 relies on Obsidian's command registry, which is not a public API: without it, layer 3 still holds.
		const restore = guardLinkCommands(
			(this.app as unknown as { commands?: CommandRegistry }).commands,
			() => {
				const editor = this.app.workspace.activeEditor?.editor;
				if (!editor) return undefined;
				const cursor = editor.getCursor();
				return s3LinkAt(editor.getLine(cursor.line), cursor.ch);
			},
			openPreview,
		);
		if (restore) this.register(restore);
	}

	private async upload(preview: boolean): Promise<void> {
		const file = uploadTarget(this.app);
		if (!file) {
			new Notice(t('insert.noEditor'));
			return;
		}
		await runUploadCommand(this.uploadHost, file, preview);
		this.settingTab?.update();
	}

	private insertReference(): void {
		const target = editTarget(this.app);
		if (!target) {
			new Notice(t('insert.noEditor'));
			return;
		}
		const modal = new InsertReferenceModal(this.app, this, target, () => this.insertModals.delete(modal));
		this.insertModals.add(modal);
		modal.open();
	}

	onunload(): void {
		// Stops an upload in flight; its Put is then recorded as of unknown outcome.
		this.unloading.abort();
		this.settingTab?.flushPendingText();
		if (this.recreateTimer !== undefined) window.clearTimeout(this.recreateTimer);
		for (const modal of [...this.insertModals]) modal.close();
		this.replacer.releaseAll();
		this.preview.destroy();
		this.handler.destroy();
	}

	get uploadHost(): UploadHost {
		return { app: this.app, store: this.store, pending: this.pending, lock: this.lock, unload: this.unloading.signal };
	}

	// ---- settings -------------------------------------------------------------------------------

	/** Absolute path of a file in this plugin's folder (desktop only), passed to `build`. */
	private pluginFile<T>(name: string, build: (path: string) => T): T | undefined {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter) || !this.manifest.dir) return undefined;
		return build(join(adapter.getBasePath(), this.manifest.dir, name));
	}

	/** Called by Obsidian when data.json changed on disk (e.g. synchronisation). */
	async onExternalSettingsChange(): Promise<void> {
		await this.store.reload();
		this.recreatePreview();
		this.settingTab?.update();
	}

	/** Shows why a change was not saved (validation errors are shown by the caller instead). */
	private noticeIfNotSaved(result: MutateResult<unknown>): boolean {
		if (result.ok) return true;
		if (result.reason !== 'rejected' && result.error[0]) new Notice(t(result.error[0]));
		return false;
	}

	/**
	 * Validates against the latest settings (a sync may have changed them since the editor opened),
	 * then saves the connection and its device-local profile. Returns error keys instead of saving on failure.
	 */
	async saveConnection(previous: StorageConnection | undefined, connection: StorageConnection, profile: string | undefined): Promise<MessageKey[]> {
		const result = await this.store.mutate(saveConnectionOp(previous, connection, profile));
		if (!result.ok) return result.error;
		this.refreshPreview(connection.id);
		return [];
	}

	async deleteConnection(id: string): Promise<void> {
		this.noticeIfNotSaved(await this.store.mutate(deleteConnectionOp(id)));
		this.refreshPreview(id);
	}

	async resolveAliasConflict(alias: string, target: string): Promise<void> {
		this.noticeIfNotSaved(await this.store.mutate(resolveConflictOp(alias, target, crypto.randomUUID())));
		this.refreshPreview();
	}

	/** Changes one plain setting. Returns false when it was invalid or not saved. */
	async setField(key: FieldKey, value: unknown): Promise<boolean> {
		return this.noticeIfNotSaved(await this.store.mutate(setFieldOp(key, value)));
	}

	/** "Reset and save" while data.json cannot be read. */
	async resetSettings(): Promise<void> {
		if (this.noticeIfNotSaved(await this.store.mutate(resetOp(), { allowUnreadable: true }))) this.recreatePreview();
	}

	/** Connections whose alias was resolved to another target on this device. */
	supersededConnections(alias: string): StorageConnection[] {
		return this.settings.connections.filter((c) => c.alias === alias && connectionState(this.settings, c) === 'superseded');
	}

	profileFor(connectionId: string): string | undefined {
		return profileOf(this.device, connectionId)?.profile;
	}

	// ---- preview --------------------------------------------------------------------------------

	private createPreview(): void {
		const { service, handler } = createPreviewStack(
			() => this.settings,
			() => this.device,
		);
		this.preview = service;
		this.handler = handler;
	}

	/** Drops cached previews (of one connection or all) and re-renders visible images. */
	refreshPreview(connectionId?: string): void {
		if (connectionId) this.preview.invalidateConnection(connectionId);
		else this.preview.invalidateAll();
		this.replacer.refresh();
	}

	private recreateTimer: number | undefined;

	/** Network settings changed: rebuild once the user has stopped typing. */
	scheduleRecreatePreview(): void {
		if (this.recreateTimer !== undefined) window.clearTimeout(this.recreateTimer);
		this.recreateTimer = window.setTimeout(() => {
			this.recreateTimer = undefined;
			this.recreatePreview();
		}, 1000);
	}

	/** Rebuilds the shared handler and service. */
	recreatePreview(): void {
		const old = { preview: this.preview, handler: this.handler };
		this.createPreview();
		old.preview.destroy();
		old.handler.destroy();
		this.replacer.refresh();
	}

	// ---- commands -------------------------------------------------------------------------------

	private testConnection(): void {
		const connections = this.settings.connections;
		if (connections.length === 0) {
			new Notice(t('notice.noConnections'));
			return;
		}
		const open = (c: StorageConnection) => new ConnectionTestModal(this.app, c, this.settings.network, this.profileFor(c.id)).open();
		if (connections.length === 1 && connections[0]) open(connections[0]);
		else new ConnectionPickerModal(this.app, connections, open).open();
	}
}
