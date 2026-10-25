// Displays of design 7-2 and 7-4 for what is not an image: built with createEl only, never from HTML.
import { t, type MessageKey } from '../i18n';
import { formatBytes } from '../upload/present';
import type { PreviewInfo, PreviewText } from './service';

const INFO_KEY: Record<PreviewInfo['type'], MessageKey> = {
	pdf: 'format.pdf',
	docx: 'format.docx',
	xlsx: 'format.xlsx',
	pptx: 'format.pptx',
	zip: 'format.zip',
	audio: 'format.audio',
	video: 'format.video',
	other: 'preview.info.other',
};

const REASON_KEY: Record<NonNullable<PreviewInfo['reason']>, MessageKey> = {
	mismatch: 'preview.info.mismatch',
	password: 'preview.pdf.password',
	broken: 'preview.pdf.broken',
};

/** Text through textContent only: nothing in it is ever parsed as markup (I17). */
export function renderText(content: PreviewText): HTMLElement {
	const box = createDiv({ cls: 'vault-s3-bridge-text-box' });
	box.createEl('pre', { cls: 'vault-s3-bridge-text', text: content.text });
	if (content.truncated) box.createDiv({ cls: 'vault-s3-bridge-text-note', text: t('preview.text.truncated') });
	return box;
}

/** Name, size and kind; no download or open action (I16). */
export function renderInfo(content: PreviewInfo): HTMLElement {
	const box = createDiv({ cls: 'vault-s3-bridge-info' });
	box.createDiv({ cls: 'vault-s3-bridge-info-name', text: content.name });
	const meta = [t(INFO_KEY[content.type]), ...(content.size === undefined ? [] : [formatBytes(content.size)])];
	box.createDiv({ cls: 'vault-s3-bridge-info-meta', text: meta.join(' · ') });
	if (content.reason) box.createDiv({ cls: 'vault-s3-bridge-info-meta', text: t(REASON_KEY[content.reason]) });
	return box;
}
