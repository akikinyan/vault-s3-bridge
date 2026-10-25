import { type App, Notice, PluginSettingTab, type SettingDefinition, type SettingDefinitionItem } from 'obsidian';
import { listSsoProfileNames, loadSharedConfig } from '../aws/profiles';
import { t, type MessageKey } from '../i18n';
import { confirm } from '../ui/ConfirmModal';
import { ConnectionEditModal } from '../ui/ConnectionEditModal';
import type VaultS3BridgePlugin from '../main';
import { resumableGroups } from '../upload/job';
import type { OtherDeviceFile } from '../upload/pending';
import { STATE_KEY } from '../upload/present';
import { archiveStatus, openRestore } from '../ui/archiveFlow';
import { copyRecords, discardOtherRecords, discardRecord, resetDamagedRecords, resumeRecords, takeOverRecords } from '../ui/pendingFlow';
import { connectionState, resolveAlias } from './registry';
import { connectionWarnings, validateProxyUrl } from './validate';
import type { StorageConnection } from './types';

import { type FieldKey, PREVIEW_BOUNDS, UPLOAD_BOUNDS } from './ops';

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
	/** Record files of other devices, read when the tab is shown (7-5). */
	private others: OtherDeviceFile[] = [];

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
				heading: t('settings.upload'),
				items: [
					{
						name: t('settings.defaultConnection'),
						desc: t('settings.defaultConnectionDesc'),
						control: {
							type: 'dropdown',
							key: 'defaultConnectionId',
							options: Object.fromEntries([
								['', t('settings.defaultConnectionNone')],
								...settings.connections.map((c) => [c.id, `${c.alias} (${c.classification === 'private' ? t('edit.private') : t('edit.public')})`]),
							]) as Record<string, string>,
						},
					},
					{ name: t('settings.webp'), desc: t('settings.webpDesc'), control: { type: 'toggle', key: 'webpEnabled' } },
					{
						name: t('settings.webpQuality'),
						visible: settings.upload.webp.enabled,
						control: { type: 'slider', key: 'webpQuality', min: UPLOAD_BOUNDS.webpQualityPercent.min, max: UPLOAD_BOUNDS.webpQualityPercent.max, step: 1 },
					},
					{ name: t('settings.stripPrivate'), desc: t('settings.stripPrivateDesc'), control: { type: 'toggle', key: 'stripPrivate' } },
					{ name: t('settings.uploadMaxFileMB'), control: { type: 'number', key: 'uploadMaxFileMB', ...UPLOAD_BOUNDS.uploadMaxFileMB, step: 1 } },
					{
						name: t('settings.uploadMaxOtherFileMB'),
						desc: t('settings.uploadMaxOtherFileDesc'),
						control: { type: 'number', key: 'uploadMaxOtherFileMB', ...UPLOAD_BOUNDS.uploadMaxOtherFileMB, step: 1 },
					},
					{ name: t('settings.uploadMaxJobMB'), desc: t('settings.uploadMaxJobDesc'), control: { type: 'number', key: 'uploadMaxJobMB', ...UPLOAD_BOUNDS.uploadMaxJobMB, step: 10 } },
					{ name: t('settings.excludeFolders'), desc: t('settings.excludeFoldersDesc'), control: { type: 'textarea', key: 'excludeFolders', rows: 3 } },
					{ name: t('settings.historyLimit'), desc: t('settings.historyLimitDesc'), control: { type: 'number', key: 'historyLimit', ...UPLOAD_BOUNDS.historyLimit, step: 100 } },
				],
			},
			...this.pendingDefinitions(),
			{
				type: 'group',
				heading: t('settings.preview'),
				items: [
					{ name: t('settings.maxFileMB'), control: { type: 'number', key: 'maxFileMB', min: 1, max: 200, step: 1 } },
					{ name: t('settings.maxPdfMB'), control: { type: 'number', key: 'maxPdfMB', ...PREVIEW_BOUNDS.maxPdfMB, step: 1 } },
					{ name: t('settings.maxTextMB'), control: { type: 'number', key: 'maxTextMB', ...PREVIEW_BOUNDS.maxTextMB, step: 1 } },
					{ name: t('settings.maxMegapixels'), desc: t('settings.maxMegapixelsDesc'), control: { type: 'number', key: 'maxMegapixels', min: 1, max: 500, step: 1 } },
					{ name: t('settings.cacheMB'), desc: t('settings.cacheDesc'), control: { type: 'number', key: 'cacheMB', min: 0, max: 2000, step: 10 } },
				],
			},
			this.archiveDefinition(),
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

	/** 7-4 and 7-5: this device's records, and the files of other devices. */
	private pendingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const pending = this.plugin.pending;
		if (!pending) return [];
		const host = this.plugin.uploadHost;
		const ready = pending.status === 'ready';
		const items = pending.items;
		const run = (op: () => Promise<void>): void => {
			void op().finally(() => void this.refreshPending());
		};
		// The other devices' files are read asynchronously; the tab is rendered again only if they changed.
		void this.refreshPending(false);
		const aliasOf = (id: string, target: string) => this.plugin.settings.connections.find((c) => c.id === id)?.alias ?? describeTarget(target);
		return [
			{
				type: 'list',
				heading: t('settings.pending'),
				visible: ready,
				emptyState: t('settings.pendingEmpty'),
				onDelete: (index) => {
					const item = items[index];
					if (item) run(() => discardRecord(host, pending, item));
				},
				items: items.map((i) => ({
					name: i.sourcePath,
					desc: [t(STATE_KEY[i.state]), aliasOf(i.connectionId, i.target), i.notePath, i.updatedAt.slice(0, 16).replace('T', ' ')].join(' · '),
				})),
			},
			{
				type: 'group',
				heading: ready ? undefined : t('settings.pending'),
				visible: !ready || items.length > 0 || this.others.length > 0,
				items: [
					{
						name: t('settings.pendingDamaged'),
						desc: t('settings.pendingDamagedDesc'),
						visible: pending.status === 'damaged',
						action: () => run(() => resetDamagedRecords(host, pending)),
					},
					// Written by a newer version: kept as is, with no reset (design 1-2).
					{ name: t('settings.pendingFuture'), desc: t('settings.pendingFutureDesc'), visible: pending.status === 'future' },
					{
						name: t('settings.pendingResume'),
						desc: t('settings.pendingResumeDesc'),
						visible: ready && resumableGroups(items).length > 0,
						action: () => run(() => resumeRecords(host, pending)),
					},
					// One copy per note: the lines go back into the note they came from.
					...[...new Set(items.filter((i) => i.state === 'delivered').map((i) => i.notePath))].map((notePath) => ({
						name: t('settings.pendingCopy', { note: notePath }),
						desc: t('settings.pendingCopyDesc'),
						visible: ready,
						action: () => run(() => copyRecords(host, pending, notePath)),
					})),
					...this.others.flatMap((o): SettingDefinition<ControlKey>[] => {
						// A file of a newer version is kept as is: it can be neither taken over nor discarded here (1-2).
						if ('future' in o) return [{ name: t('settings.pendingOtherFuture'), desc: t('settings.pendingFutureDesc') }];
						const name = 'damaged' in o ? t('settings.pendingOtherDamaged') : t('settings.pendingOther', { n: String(o.count) });
						return [
							{
								name: `${name} — ${t('settings.pendingTakeOver')}`,
								desc: t('settings.pendingOtherDesc'),
								visible: ready && !('damaged' in o),
								action: () => run(() => takeOverRecords(host, pending, o.deviceId)),
							},
							{ name: `${name} — ${t('settings.pendingOtherDiscard')}`, action: () => run(() => discardOtherRecords(host, pending, o.deviceId)) },
						];
					}),
				],
			},
		];
	}

	/**
	 * Design 9-3: the archive folder's state. Read asynchronously into the row itself on every render: update() does
	 * not redraw the description of a row already shown.
	 */
	private archiveDefinition(): SettingDefinitionItem<ControlKey> {
		return {
			type: 'group',
			heading: t('settings.archive'),
			items: [
				{
					name: t('settings.archiveOpen'),
					render: (setting) => {
						let shown = true;
						const refresh = () =>
							void archiveStatus(this.app).then((desc) => {
								if (shown) setting.setDesc(desc);
							});
						setting.setName(t('settings.archiveOpen'));
						refresh();
						setting.addButton((b) => b.setButtonText(t('settings.archiveList')).onClick(() => void openRestore(this.plugin.uploadHost, refresh)));
						return () => {
							shown = false;
						};
					},
				},
			],
		};
	}

	/** Reads the other devices' files again and re-renders (always after an operation; on display only if they changed). */
	private async refreshPending(always = true): Promise<void> {
		const others = (await this.plugin.pending?.others()) ?? [];
		const changed = JSON.stringify(others) !== JSON.stringify(this.others);
		this.others = others;
		if (always || changed) this.update();
	}

	private connectionItem(connection: StorageConnection) {
		const state = connectionState(this.plugin.settings, connection);
		const notes: string[] = [`${connection.classification === 'private' ? t('edit.private') : t('edit.public')} · ${connection.bucket} · ${connection.region}`];
		const label = STATE_LABEL[state];
		if (label) notes.push(`⚠ ${t(label)}`);
		if (!this.plugin.profileFor(connection.id)) notes.push(`⚠ ${t('settings.state.profileNotSet')}`);
		for (const w of connectionWarnings(connection)) if (w.key !== 'upload.confirm.identifying') notes.push(`⚠ ${t(w.key, w.params)}`);
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
			case 'maxPdfMB':
				return s.preview.maxPdfMB;
			case 'maxTextMB':
				return s.preview.maxTextMB;
			case 'maxMegapixels':
				return s.preview.maxMegapixels;
			case 'cacheMB':
				return s.preview.cacheMB;
			case 'defaultConnectionId':
				return s.upload.defaultConnectionId ?? '';
			case 'webpEnabled':
				return s.upload.webp.enabled;
			case 'webpQuality':
				return Math.round(s.upload.webp.quality * 100);
			case 'stripPrivate':
				return s.upload.stripPrivate;
			case 'uploadMaxFileMB':
				return s.upload.maxFileMB;
			case 'uploadMaxOtherFileMB':
				return s.upload.maxOtherFileMB;
			case 'uploadMaxJobMB':
				return s.upload.maxJobMB;
			case 'excludeFolders':
				return s.upload.excludeFolders.join('\n');
			case 'historyLimit':
				return s.historyLimit;
		}
		return undefined;
	}

	private readonly pendingText = new Map<ControlKey, { timer: number; value: unknown }>();

	async setControlValue(key: string, value: unknown): Promise<void> {
		const k = key as ControlKey;
		// Text fields save once typing pauses: every save re-reads and rewrites data.json.
		if (k === 'proxyUrl' || k === 'noProxy' || k === 'excludeFolders') {
			if (k === 'proxyUrl' && validateProxyUrl(String(value).trim() || undefined)) return;
			const previous = this.pendingText.get(k);
			if (previous) window.clearTimeout(previous.timer);
			const timer = window.setTimeout(() => {
				this.pendingText.delete(k);
				void this.applyControl(k, value);
			}, TEXT_SAVE_DELAY_MS);
			this.pendingText.set(k, { timer, value });
			return;
		}
		await this.applyControl(k, value);
	}

	/** Saves text that is still waiting for the typing pause (the tab is closing). */
	flushPendingText(): void {
		for (const [key, { timer, value }] of [...this.pendingText]) {
			window.clearTimeout(timer);
			this.pendingText.delete(key);
			void this.applyControl(key, value);
		}
	}

	hide(): void {
		this.flushPendingText();
		super.hide();
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
			case 'webpEnabled':
				this.update();
				return;
			case 'maxFileMB':
			case 'maxPdfMB':
			case 'maxTextMB':
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
