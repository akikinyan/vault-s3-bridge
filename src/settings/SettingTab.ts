import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { listSsoProfileNames, loadSharedConfig } from '../aws/profiles';
import { t, type MessageKey } from '../i18n';
import { confirm } from '../ui/ConfirmModal';
import { ConnectionEditModal } from '../ui/ConnectionEditModal';
import type VaultS3BridgePlugin from '../main';
import { validateProxyUrl } from './validate';
import type { LanguageSetting, StorageConnection } from './types';

type ControlKey = 'proxyUrl' | 'noProxy' | 'timeoutSeconds' | 'language';

export class VaultS3BridgeSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultS3BridgePlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const connections = this.plugin.settings.connections;
		return [
			{
				type: 'list',
				heading: t('settings.connections'),
				emptyState: t('settings.noConnections'),
				addItem: { name: t('settings.addConnection'), action: () => void this.openEditor(undefined) },
				onDelete: (index) => void this.deleteConnection(index),
				items: connections.map((connection) => ({
					name: connection.alias,
					desc: `${connection.classification === 'private' ? t('edit.private') : t('edit.public')} · ${connection.bucket} · ${connection.region}`,
					action: () => void this.openEditor(connection),
				})),
			},
			{
				type: 'group',
				heading: t('settings.network'),
				items: [
					{
						name: t('settings.proxy'),
						desc: t('settings.proxyDesc'),
						control: {
							type: 'text',
							key: 'proxyUrl',
							placeholder: 'http://proxy.example.com:8080',
							validate: (value) => {
								const error = validateProxyUrl(value.trim() || undefined);
								return error ? t(`error.${error}` as MessageKey) : undefined;
							},
						},
					},
					{
						name: t('settings.noProxy'),
						desc: t('settings.noProxyDesc'),
						control: { type: 'text', key: 'noProxy' },
					},
					{
						name: t('settings.timeout'),
						control: { type: 'number', key: 'timeoutSeconds', min: 1, max: 300, step: 1 },
					},
				],
			},
			{
				type: 'group',
				heading: t('settings.general'),
				items: [
					{
						name: t('settings.language'),
						control: {
							type: 'dropdown',
							key: 'language',
							options: { auto: t('settings.languageAuto'), ja: '日本語', en: 'English' },
						},
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		switch (key as ControlKey) {
			case 'proxyUrl':
				return s.network.proxyUrl ?? '';
			case 'noProxy':
				return s.network.noProxy ?? '';
			case 'timeoutSeconds':
				return s.network.timeoutMs / 1000;
			case 'language':
				return s.language;
		}
		return undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		switch (key as ControlKey) {
			case 'proxyUrl': {
				const v = String(value).trim() || undefined;
				if (validateProxyUrl(v)) return;
				s.network.proxyUrl = v;
				break;
			}
			case 'noProxy':
				s.network.noProxy = String(value).trim() || undefined;
				break;
			case 'timeoutSeconds': {
				const seconds = Number(value);
				if (!Number.isFinite(seconds) || seconds <= 0) return;
				s.network.timeoutMs = Math.round(seconds * 1000);
				break;
			}
			case 'language':
				s.language = value === 'ja' || value === 'en' ? value : ('auto' satisfies LanguageSetting);
				await this.plugin.saveSettings();
				this.update();
				return;
		}
		await this.plugin.saveSettings();
	}

	private async deleteConnection(index: number): Promise<void> {
		const connection = this.plugin.settings.connections[index];
		if (!connection) return;
		if (!(await confirm(this.app, t('edit.confirmDelete', { alias: connection.alias }), t('settings.delete')))) return;
		this.plugin.settings.connections = this.plugin.settings.connections.filter((c) => c.id !== connection.id);
		await this.plugin.saveSettings();
		this.update();
	}

	private async openEditor(previous: StorageConnection | undefined): Promise<void> {
		let profiles: string[] = [];
		try {
			profiles = listSsoProfileNames(await loadSharedConfig());
		} catch {
			new Notice(t('edit.noProfiles'));
		}
		new ConnectionEditModal(this.app, previous, this.plugin.settings.connections, profiles, async (saved) => {
			const list = this.plugin.settings.connections;
			const index = list.findIndex((c) => c.id === saved.id);
			if (index >= 0) list[index] = saved;
			else list.push(saved);
			await this.plugin.saveSettings();
			this.update();
		}).open();
	}
}
