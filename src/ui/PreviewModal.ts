// Design 7-6: what a click on an `s3-bridge:` link shows, inside Obsidian and nowhere else (I18).
import { type App, Modal } from 'obsidian';
import { t } from '../i18n';
import { parseReference } from '../reference/reference';
import { renderPlaceholder } from '../preview/placeholder';
import type { ContentRenderer } from '../preview/display';
import { ImageReplacer, type LeaseSource } from '../preview/replacer';

export class PreviewModal extends Modal {
	private readonly replacer: ImageReplacer;

	constructor(
		app: App,
		private readonly url: string,
		source: () => LeaseSource,
		renderOther: ContentRenderer,
	) {
		super(app);
		this.replacer = new ImageReplacer(source, renderPlaceholder, renderOther);
	}

	onOpen(): void {
		const parsed = parseReference(this.url);
		this.setTitle(parsed.ok ? parsed.value.key.slice(parsed.value.key.lastIndexOf('/') + 1) : t('preview.modal.title'));
		this.contentEl.addClass('vault-s3-bridge-preview-modal');
		// The same path as an embed: the replacer fetches it and shows the image, SVG, text, PDF or information.
		const img = this.contentEl.createEl('img');
		img.setAttribute('src', this.url);
		this.replacer.process(img);
	}

	onClose(): void {
		this.replacer.releaseAll();
		this.contentEl.empty();
	}
}
