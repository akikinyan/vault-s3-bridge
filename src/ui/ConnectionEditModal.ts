import { type App, Modal, Notice, Setting } from 'obsidian';
import { t, type MessageKey } from '../i18n';
import type { StorageConnection } from '../settings/types';

/**
 * Creates or edits one connection. Alias, bucket and endpoint are fixed after creation;
 * the AWS profile is stored only on this device.
 */
export class ConnectionEditModal extends Modal {
	private draft: StorageConnection;
	private profile: string | undefined;

	constructor(
		app: App,
		private readonly previous: StorageConnection | undefined,
		private readonly ssoProfiles: readonly string[],
		currentProfile: string | undefined,
		/** Validates against the latest settings; returns error keys, or an empty list once saved. */
		private readonly onSave: (previous: StorageConnection | undefined, connection: StorageConnection, profile: string | undefined) => Promise<MessageKey[]>,
	) {
		super(app);
		this.profile = currentProfile ?? ssoProfiles[0];
		this.draft = previous
			? structuredClone(previous)
			: { id: crypto.randomUUID(), alias: '', provider: 'aws-s3', classification: 'private', bucket: '', region: '' };
	}

	onOpen(): void {
		this.setTitle(t('edit.title'));
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const d = this.draft;
		const existing = this.previous !== undefined;

		new Setting(contentEl)
			.setName(t('edit.alias'))
			.setDesc(existing ? t('edit.immutableDesc') : t('edit.aliasDesc'))
			.addText((text) => text.setValue(d.alias).setDisabled(existing).onChange((v) => (d.alias = v.trim())));

		const lockedPrivate = this.previous?.classification === 'private';
		new Setting(contentEl)
			.setName(t('edit.classification'))
			.setDesc(t('edit.classificationDesc'))
			.addDropdown((dropdown) => {
				dropdown.addOption('private', t('edit.private'));
				if (!lockedPrivate) dropdown.addOption('public', t('edit.public'));
				dropdown
					.setValue(d.classification)
					.setDisabled(lockedPrivate)
					.onChange((v) => {
						d.classification = v === 'public' ? 'public' : 'private';
						this.render();
					});
			});

		const profileSetting = new Setting(contentEl).setName(t('edit.profile')).setDesc(t('edit.profileLocalDesc'));
		if (this.ssoProfiles.length === 0) {
			profileSetting.setDesc(t('edit.noProfiles'));
		} else {
			profileSetting.addDropdown((dropdown) => {
				for (const name of this.ssoProfiles) dropdown.addOption(name, name);
				if (this.profile && !this.ssoProfiles.includes(this.profile)) dropdown.addOption(this.profile, this.profile);
				dropdown.setValue(this.profile ?? '').onChange((v) => (this.profile = v || undefined));
			});
		}

		new Setting(contentEl)
			.setName(t('edit.bucket'))
			.setDesc(existing ? t('edit.immutableDesc') : t('edit.bucketDesc'))
			.addText((text) => text.setValue(d.bucket).setDisabled(existing).onChange((v) => (d.bucket = v.trim())));
		new Setting(contentEl)
			.setName(t('edit.region'))
			.setDesc(t('edit.regionDesc'))
			.addText((text) => text.setValue(d.region).onChange((v) => (d.region = v.trim())));

		// Path-style access only matters for S3-compatible storage, so it is shown only with a custom endpoint.
		let pathStyle: Setting | undefined;
		new Setting(contentEl)
			.setName(t('edit.endpoint'))
			.setDesc(existing ? t('edit.immutableDesc') : t('edit.endpointDesc'))
			.addText((text) =>
				text
					.setValue(d.endpoint ?? '')
					.setDisabled(existing)
					.onChange((v) => {
						d.endpoint = v.trim() || undefined;
						pathStyle?.settingEl.toggle(d.endpoint !== undefined);
					}),
			);
		pathStyle = new Setting(contentEl)
			.setName(t('edit.pathStyle'))
			.setDesc(t('edit.pathStyleDesc'))
			.addToggle((toggle) => toggle.setValue(d.forcePathStyle === true).onChange((v) => (d.forcePathStyle = v || undefined)));
		pathStyle.settingEl.toggle(d.endpoint !== undefined);

		if (d.classification === 'public') {
			new Setting(contentEl)
				.setName(t('edit.publicBaseUrl'))
				.addText((text) => text.setValue(d.publicBaseUrl ?? '').onChange((v) => (d.publicBaseUrl = v.trim() || undefined)));
		}

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t('edit.save'))
				.setCta()
				.onClick(() => void this.save()),
		);
	}

	private async save(): Promise<void> {
		const next: StorageConnection = {
			...this.draft,
			publicBaseUrl: this.draft.classification === 'public' ? this.draft.publicBaseUrl : undefined,
			// Hidden without a custom endpoint, so it must not stay in effect either.
			forcePathStyle: this.draft.endpoint ? this.draft.forcePathStyle : undefined,
		};
		const errors = await this.onSave(this.previous, next, this.profile);
		if (errors.length > 0) {
			new Notice(errors.map((k) => t(k)).join('\n'));
			return;
		}
		this.close();
	}
}
