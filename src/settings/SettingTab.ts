import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';
import { listSsoProfileNames, loadSharedConfig } from '../aws/profiles';
import { t, type MessageKey } from '../i18n';
import { confirm } from '../ui/ConfirmModal';
import { ConnectionEditModal } from '../ui/ConnectionEditModal';
import type VaultS3BridgePlugin from '../main';
import { connectionState, resolveAlias } from './registry';
import { validateProxyUrl } from './validate';
import type { StorageConnection } from './types';

import type { FieldKey } from './ops';

type ControlKey = FieldKey;

const TEXT_SAVE_DELAY_MS = 500;

const STATE_LABEL: Record<string, MessageKey> = {
	conflict: 'settings.state.conflict',
	superseded: 'settings.state.superseded',
	blocked: 'settings.state.blocked',
};

/** `aws:bucket` / `s3c:host/bucket` → human readable. */
function describeTarget(target: string): string {
	return target.replace(/^aws:/, 'AWS S3 · ').replace(/^s3c:/, '');
}

export class VaultS3BridgeSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: VaultS3BridgePlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const settings = this.plugin.settings;
		const aliases = [...new Set(settings.aliasBindings.map((b) => b.alias))].sort();
		const conflicts = aliases.flatMap((alias) => {
			const state = resolveAlias(settings, alias);
			return state.kind === 'conflict' ? [{ alias, candidates: state.candidates }] : [];
		});
		const missing = aliases.flatMap((alias) => {
			const state = resolveAlias(settings, alias);
			const hasConnection = settings.connections.some((c) => c.alias === alias && connectionState(settings, c) === 'active');
			return state.kind === 'resolved' && !hasConnection ? [{ alias, target: state.target }] : [];
		});

		return [
			{
				type: 'group',
				heading: t('settings.unreadable'),
				visible: this.plugin.readOnly === 'unreadable',
				items: [{ name: t('settings.reset'), desc: t('settings.unreadableDesc'), action: () => void this.reset() }],
			},
			{
				type: 'list',
				heading: t('settings.connections'),
				emptyState: t('settings.noConnections'),
				addItem: { name: t('settings.addConnection'), action: () => void this.openEditor(undefined) },
				onDelete: (index) => void this.deleteConnection(index),
				items: settings.connections.map((connection) => this.connectionItem(connection)),
			},
			{
				type: 'group',
				heading: t('settings.conflicts'),
				visible: conflicts.length > 0,
				items: conflicts.flatMap(({ alias, candidates }) =>
					candidates.map((target) => ({
						name: `${alias} → ${describeTarget(target)}`,
						desc: t('settings.conflictDesc'),
						action: () => void this.resolve(alias, target),
					})),
				),
			},
			{
				type: 'group',
				heading: t('settings.missing'),
				visible: missing.length > 0,
				items: missing.map(({ alias, target }) => ({ name: `${alias} → ${describeTarget(target)}`, desc: t('settings.missingDesc') })),
			},
			{
				type: 'group',
				heading: t('settings.preview'),
				items: [
					{ name: t('settings.maxFileMB'), control: { type: 'number', key: 'maxFileMB', min: 1, max: 200, step: 1 } },
					{ name: t('settings.maxMegapixels'), control: { type: 'number', key: 'maxMegapixels', min: 1, max: 500, step: 1 } },
					{ name: t('settings.cacheMB'), desc: t('settings.cacheDesc'), control: { type: 'number', key: 'cacheMB', min: 0, max: 2000, step: 10 } },
				],
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
					{ name: t('settings.noProxy'), desc: t('settings.noProxyDesc'), control: { type: 'text', key: 'noProxy' } },
					{ name: t('settings.timeout'), control: { type: 'number', key: 'timeoutSeconds', min: 1, max: 300, step: 1 } },
				],
			},
			{
				type: 'group',
				heading: t('settings.general'),
				items: [
					{
						name: t('settings.language'),
						control: { type: 'dropdown', key: 'language', options: { auto: t('settings.languageAuto'), ja: '日本語', en: 'English' } },
					},
				],
			},
		];
	}

	private connectionItem(connection: StorageConnection) {
		const state = connectionState(this.plugin.settings, connection);
		const notes: string[] = [`${connection.classification === 'private' ? t('edit.private') : t('edit.public')} · ${connection.bucket} · ${connection.region}`];
		const label = STATE_LABEL[state];
		if (label) notes.push(`⚠ ${t(label)}`);
		if (!this.plugin.profileFor(connection.id)) notes.push(`⚠ ${t('settings.state.profileNotSet')}`);
		return { name: connection.alias, desc: notes.join(' — '), action: () => void this.openEditor(connection) };
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
			case 'maxFileMB':
				return s.preview.maxFileMB;
			case 'maxMegapixels':
				return s.preview.maxMegapixels;
			case 'cacheMB':
				return s.preview.cacheMB;
		}
		return undefined;
	}

	private readonly pendingText = new Map<ControlKey, number>();

	async setControlValue(key: string, value: unknown): Promise<void> {
		const k = key as ControlKey;
		// Text fields save once typing pauses: every save re-reads and rewrites data.json.
		if (k === 'proxyUrl' || k === 'noProxy') {
			if (k === 'proxyUrl' && validateProxyUrl(String(value).trim() || undefined)) return;
			const previous = this.pendingText.get(k);
			if (previous !== undefined) window.clearTimeout(previous);
			this.pendingText.set(
				k,
				window.setTimeout(() => {
					this.pendingText.delete(k);
					void this.applyControl(k, value);
				}, TEXT_SAVE_DELAY_MS),
			);
			return;
		}
		await this.applyControl(k, value);
	}

	private async applyControl(key: ControlKey, value: unknown): Promise<void> {
		if (!(await this.plugin.setField(key, value))) return;
		switch (key) {
			case 'proxyUrl':
			case 'noProxy':
			case 'timeoutSeconds':
				this.plugin.scheduleRecreatePreview();
				return;
			case 'language':
				this.update();
				return;
			case 'maxFileMB':
			case 'maxMegapixels':
			case 'cacheMB':
				// Limits apply to the next download; only the cache budget needs enforcing now.
				this.plugin.preview.evictUnused();
				return;
		}
	}

	private async reset(): Promise<void> {
		if (!(await confirm(this.app, t('settings.confirmReset'), t('settings.reset')))) return;
		await this.plugin.resetSettings();
		this.update();
	}

	private async deleteConnection(index: number): Promise<void> {
		const connection = this.plugin.settings.connections[index];
		if (!connection) return;
		if (!(await confirm(this.app, t('edit.confirmDelete', { alias: connection.alias }), t('settings.delete')))) return;
		await this.plugin.deleteConnection(connection.id);
		this.update();
	}

	private async resolve(alias: string, target: string): Promise<void> {
		if (!(await confirm(this.app, `${alias} → ${describeTarget(target)}`, t('settings.resolve')))) return;
		await this.plugin.resolveAliasConflict(alias, target);
		for (const c of this.plugin.supersededConnections(alias)) {
			if (await confirm(this.app, t('edit.confirmDelete', { alias: `${c.alias} (${c.bucket})` }), t('settings.delete'))) {
				await this.plugin.deleteConnection(c.id);
			}
		}
		this.update();
	}

	private async openEditor(previous: StorageConnection | undefined): Promise<void> {
		let profiles: string[] = [];
		try {
			profiles = listSsoProfileNames(await loadSharedConfig());
		} catch {
			new Notice(t('edit.noProfiles'));
		}
		const current = previous ? this.plugin.profileFor(previous.id) : undefined;
		new ConnectionEditModal(this.app, previous, profiles, current, async (prev, saved, profile) => {
			const errors = await this.plugin.saveConnection(prev, saved, profile);
			this.update();
			return errors;
		}).open();
	}
}
