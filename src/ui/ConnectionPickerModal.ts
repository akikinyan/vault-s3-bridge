import { type App, SuggestModal } from 'obsidian';
import { t } from '../i18n';
import type { StorageConnection } from '../settings/types';

export class ConnectionPickerModal extends SuggestModal<StorageConnection> {
	constructor(
		app: App,
		private readonly connections: readonly StorageConnection[],
		private readonly onPick: (connection: StorageConnection) => void,
	) {
		super(app);
		this.setPlaceholder(t('picker.placeholder'));
	}

	getSuggestions(query: string): StorageConnection[] {
		const q = query.toLowerCase();
		return this.connections.filter((c) => c.alias.includes(q) || c.bucket.toLowerCase().includes(q));
	}

	renderSuggestion(connection: StorageConnection, el: HTMLElement): void {
		el.createDiv({ text: connection.alias });
		el.createEl('small', {
			text: `${connection.classification === 'private' ? t('edit.private') : t('edit.public')} · ${connection.bucket}`,
		});
	}

	onChooseSuggestion(connection: StorageConnection): void {
		this.onPick(connection);
	}
}
