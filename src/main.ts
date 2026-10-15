import type { NodeHttpHandler } from '@smithy/node-http-handler';
import { getLanguage, MarkdownRenderChild, Notice, Plugin } from 'obsidian';
import { setLanguage, t, type MessageKey } from './i18n';
import { livePreviewExtension } from './preview/livePreview';
import { renderPlaceholder } from './preview/placeholder';
import { ImageReplacer } from './preview/replacer';
import type { PreviewService } from './preview/service';
import { createPreviewStack } from './preview/stack';
import { loadDeviceState, profileOf, saveDeviceState, setProfile, type DeviceState, type DeviceStorage } from './settings/device';
import { loadSettings, serializeSettings } from './settings/migrate';
import { checkConnectionSave } from './settings/connectionSave';
import { connectionState, recordConnection, recordsOf, resolveConflict, type Records } from './settings/registry';
import { VaultS3BridgeSettingTab } from './settings/SettingTab';
import type { PluginSettings, StorageConnection } from './settings/types';
import { ConnectionPickerModal } from './ui/ConnectionPickerModal';
import { ConnectionTestModal } from './ui/ConnectionTestModal';
import { InsertReferenceModal } from './ui/InsertReferenceModal';

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
	settings!: PluginSettings;
	device!: DeviceState;
	/** data.json was written by a newer schema version; never save over it. */
	readOnly = false;
	preview!: PreviewService;
	private handler!: NodeHttpHandler;
	private replacer!: ImageReplacer;
	private settingTab?: VaultS3BridgeSettingTab;
	private readonly insertModals = new Set<InsertReferenceModal>();

	private readonly deviceStorage: DeviceStorage = {
		load: (key) => this.app.loadLocalStorage(key) as unknown,
		save: (key, data) => this.app.saveLocalStorage(key, data),
	};

	async onload(): Promise<void> {
		await this.loadSettings();
		this.createPreview();
		this.replacer = new ImageReplacer(() => this.preview, renderPlaceholder);

		this.registerMarkdownPostProcessor((el, ctx) => {
			this.replacer.processTree(el);
			if (el.querySelector('img[data-s3-bridge-ref]')) ctx.addChild(new PreviewChild(el, this.replacer));
		});
		this.registerEditorExtension(livePreviewExtension(this.replacer));
		this.registerInterval(window.setInterval(() => this.replacer.sweep(), SWEEP_INTERVAL_MS));

		this.settingTab = new VaultS3BridgeSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addCommand({ id: 'test-connection', name: t('command.testConnection'), callback: () => this.testConnection() });
		this.addCommand({
			id: 'insert-private-reference',
			name: t('command.insertReference'),
			editorCallback: (editor, view) => {
					const modal = new InsertReferenceModal(this.app, this, editor, view, () => this.insertModals.delete(modal));
					this.insertModals.add(modal);
					modal.open();
				},
		});
	}

	onunload(): void {
		if (this.recreateTimer !== undefined) window.clearTimeout(this.recreateTimer);
		for (const modal of [...this.insertModals]) modal.close();
		this.replacer.releaseAll();
		this.preview.destroy();
		this.handler.destroy();
	}

	// ---- settings -------------------------------------------------------------------------------

	async loadSettings(): Promise<void> {
		this.device = loadDeviceState(this.deviceStorage);
		const result = loadSettings(await this.loadData(), this.device);
		this.settings = result.settings;
		this.readOnly = result.readOnly;
		saveDeviceState(this.deviceStorage, this.device);
		if (result.changed) await this.saveData(serializeSettings(this.settings));
		setLanguage(this.settings.language, getLanguage());
	}

	async saveSettings(): Promise<void> {
		setLanguage(this.settings.language, getLanguage());
		this.device.mirror = recordsOf(this.settings);
		saveDeviceState(this.deviceStorage, this.device);
		if (this.readOnly) {
			new Notice(t('notice.readOnly'));
			return;
		}
		await this.saveData(serializeSettings(this.settings));
	}

	/** Called by Obsidian when data.json changed on disk (e.g. synchronisation). */
	async onExternalSettingsChange(): Promise<void> {
		await this.loadSettings();
		this.recreatePreview();
		this.settingTab?.update();
	}

	private setRecords(records: Records): void {
		Object.assign(this.settings, records);
	}

	/**
	 * Validates against the current settings (they may have been replaced by a sync since the editor opened),
	 * then saves the connection and its device-local profile. Returns error keys instead of saving on failure.
	 */
	async saveConnection(previous: StorageConnection | undefined, connection: StorageConnection, profile: string | undefined): Promise<MessageKey[]> {
		const errors = checkConnectionSave(this.settings, previous, connection);
		if (errors.length > 0) return errors;
		const list = this.settings.connections;
		const records = recordsOf(this.settings);
		const index = list.findIndex((c) => c.id === connection.id);
		if (index >= 0) list[index] = connection;
		else list.push(connection);
		this.setRecords(recordConnection(records, connection));
		setProfile(this.device, connection.id, profile);
		await this.saveSettings();
		this.refreshPreview(connection.id);
		return [];
	}

	async deleteConnection(id: string): Promise<void> {
		this.settings.connections = this.settings.connections.filter((c) => c.id !== id);
		delete this.device.profiles[id];
		await this.saveSettings();
		this.refreshPreview(id);
	}

	async resolveAliasConflict(alias: string, target: string): Promise<void> {
		this.setRecords(resolveConflict(recordsOf(this.settings), alias, target, crypto.randomUUID()));
		await this.saveSettings();
		this.refreshPreview();
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
