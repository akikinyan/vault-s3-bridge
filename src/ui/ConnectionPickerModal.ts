import { type App, SuggestModal } from 'obsidian';
import { t } from '../i18n';
import type { StorageConnection } from '../settings/types';
import type { DeepReadonly } from '../util/deepReadonly';

export class ConnectionPickerModal<C extends DeepReadonly<StorageConnection> = StorageConnection> extends SuggestModal<C> {
	constructor(
		app: App,
		private readonly connections: readonly C[],
		private readonly onPick: (connection: C) => void,
		placeholder = t('picker.placeholder'),
		private readonly onDismiss?: () => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	getSuggestions(query: string): C[] {
		const q = query.toLowerCase();
		return this.connections.filter((c) => c.alias.includes(q) || c.bucket.toLowerCase().includes(q));
	}

	renderSuggestion(connection: C, el: HTMLElement): void {
		el.createDiv({ text: connection.alias });
		el.createEl('small', {
			text: `${connection.classification === 'private' ? t('edit.private') : t('edit.public')} · ${connection.bucket}`,
		});
	}

	onChooseSuggestion(connection: C): void {
		this.onPick(connection);
	}

	onClose(): void {
		super.onClose();
		this.onDismiss?.();
	}
}

/** Resolves to the chosen connection, or undefined when the picker was closed without a choice. */
export function pickConnection<C extends DeepReadonly<StorageConnection>>(app: App, connections: readonly C[], placeholder: string): Promise<C | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		const settle = (c: C | undefined) => {
			if (settled) return;
			settled = true;
			resolve(c);
		};
		// The modal may close before onChooseSuggestion runs: give a choice the chance to arrive first.
		new ConnectionPickerModal(app, connections, settle, placeholder, () => window.setTimeout(() => settle(undefined), 0)).open();
	});
}
