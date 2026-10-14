import { getLanguage, Notice, Plugin } from 'obsidian';
import { setLanguage, t } from './i18n';
import { migrateSettings } from './settings/migrate';
import { VaultS3BridgeSettingTab } from './settings/SettingTab';
import type { PluginSettings } from './settings/types';
import { ConnectionPickerModal } from './ui/ConnectionPickerModal';
import { ConnectionTestModal } from './ui/ConnectionTestModal';

export default class VaultS3BridgePlugin extends Plugin {
	settings!: PluginSettings;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new VaultS3BridgeSettingTab(this.app, this));
		this.addCommand({
			id: 'test-connection',
			name: t('command.testConnection'),
			callback: () => this.testConnection(),
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());
		setLanguage(this.settings.language, getLanguage());
	}

	async saveSettings(): Promise<void> {
		setLanguage(this.settings.language, getLanguage());
		await this.saveData(this.settings);
	}

	private testConnection(): void {
		const connections = this.settings.connections;
		if (connections.length === 0) {
			new Notice(t('notice.noConnections'));
			return;
		}
		const open = (c: (typeof connections)[number]) => new ConnectionTestModal(this.app, c, this.settings.network).open();
		if (connections.length === 1 && connections[0]) open(connections[0]);
		else new ConnectionPickerModal(this.app, connections, open).open();
	}
}
