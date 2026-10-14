import { type App, Modal, Notice, Setting } from 'obsidian';
import { t, type MessageKey } from '../i18n';
import { changesPrivateTarget, validateConnection } from '../settings/validate';
import type { StorageConnection } from '../settings/types';
import { confirm } from './ConfirmModal';

/** Creates or edits one connection. `onSave` is called only with a validated connection. */
export class ConnectionEditModal extends Modal {
	private draft: StorageConnection;

	constructor(
		app: App,
		private readonly previous: StorageConnection | undefined,
		private readonly others: readonly StorageConnection[],
		private readonly ssoProfiles: readonly string[],
		private readonly onSave: (connection: StorageConnection) => Promise<void>,
	) {
		super(app);
		this.draft = previous
			? structuredClone(previous)
			: {
					id: crypto.randomUUID(),
					alias: '',
					provider: 'aws-s3',
					classification: 'private',
					auth: { type: 'aws-sso-profile', profile: ssoProfiles[0] ?? '' },
					bucket: '',
					region: '',
				};
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

		new Setting(contentEl)
			.setName(t('edit.alias'))
			.setDesc(t('edit.aliasDesc'))
			.addText((text) => text.setValue(d.alias).onChange((v) => (d.alias = v.trim())));

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

		const profileSetting = new Setting(contentEl).setName(t('edit.profile')).setDesc(t('edit.profileDesc'));
		if (this.ssoProfiles.length === 0) {
			profileSetting.setDesc(t('edit.noProfiles'));
		} else {
			profileSetting.addDropdown((dropdown) => {
				for (const name of this.ssoProfiles) dropdown.addOption(name, name);
				if (d.auth.profile && !this.ssoProfiles.includes(d.auth.profile)) dropdown.addOption(d.auth.profile, d.auth.profile);
				dropdown.setValue(d.auth.profile).onChange((v) => (d.auth.profile = v));
			});
		}

		new Setting(contentEl)
			.setName(t('edit.bucket'))
			.setDesc(t('edit.bucketDesc'))
			.addText((text) => text.setValue(d.bucket).onChange((v) => (d.bucket = v.trim())));
		new Setting(contentEl)
			.setName(t('edit.region'))
			.setDesc(t('edit.regionDesc'))
			.addText((text) => text.setValue(d.region).onChange((v) => (d.region = v.trim())));
		// Path-style access only matters for S3-compatible storage, so it is shown only with a custom endpoint.
		let pathStyle: Setting | undefined;
		new Setting(contentEl)
			.setName(t('edit.endpoint'))
			.setDesc(t('edit.endpointDesc'))
			.addText((text) =>
				text.setValue(d.endpoint ?? '').onChange((v) => {
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
		const errors = validateConnection(next, this.previous, this.others);
		if (errors.length > 0) {
			new Notice(errors.map((e) => t(`error.${e}` as MessageKey)).join('\n'));
			return;
		}
		if (changesPrivateTarget(next, this.previous) && !(await confirm(this.app, t('edit.confirmTarget'), t('edit.confirm')))) {
			return;
		}
		await this.onSave(next);
		this.close();
	}
}
