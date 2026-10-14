import { t, tDynamic } from '../i18n';
import { parseReference } from '../reference/reference';
import type { PreviewError } from './errors';

/** Short, non-sensitive explanation shown in place of an image that cannot be displayed. */
export function renderPlaceholder(error: PreviewError, reference: string): HTMLElement {
	const box = createSpan({ cls: ['vault-s3-bridge-placeholder', `is-${error.code}`] });
	box.createSpan({ cls: 'vault-s3-bridge-placeholder-title', text: tDynamic(`preview.${error.code}`, 'preview.unknown') });
	const parsed = parseReference(reference);
	box.createSpan({
		cls: 'vault-s3-bridge-placeholder-detail',
		text: parsed.ok ? `${parsed.value.alias} / ${parsed.value.key}` : reference,
	});
	if (error.code === 'sso-login-required') box.createSpan({ cls: 'vault-s3-bridge-placeholder-detail', text: t('preview.ssoHint') });
	return box;
}
