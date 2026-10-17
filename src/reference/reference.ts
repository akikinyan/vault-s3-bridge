export const REFERENCE_SCHEME = 's3-bridge:';
const PREFIX = 's3-bridge://';
const ALIAS = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_KEY_BYTES = 1024;
// encodeURIComponent leaves these unescaped; they would break Markdown link syntax.
const EXTRA = /[!'()*]/g;

export type ReferenceError = 'not-a-reference' | 'invalid-alias' | 'invalid-encoding' | 'invalid-key';

export interface ParsedReference {
	alias: string;
	key: string;
}

export function isValidAlias(alias: string): boolean {
	return ALIAS.test(alias);
}

/** Returns why the key cannot be referenced, or undefined when it can. */
export function checkKey(key: string): 'invalid-key' | undefined {
	if (key === '' || new TextEncoder().encode(key).length > MAX_KEY_BYTES) return 'invalid-key';
	if (key.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return 'invalid-key';
	return undefined;
}

/** Percent-encodes one key segment so the result contains only [A-Za-z0-9-_.~%]. */
export function encodeSegment(segment: string): string {
	return encodeURIComponent(segment).replace(EXTRA, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Builds `s3-bridge://<alias>/<key>`. The result contains only [A-Za-z0-9-_.~/%]. */
export function formatReference(alias: string, key: string): string {
	if (!isValidAlias(alias)) throw new Error('invalid-alias');
	if (checkKey(key)) throw new Error('invalid-key');
	return PREFIX + alias + '/' + key.split('/').map(encodeSegment).join('/');
}

export function parseReference(src: string): { ok: true; value: ParsedReference } | { ok: false; reason: ReferenceError } {
	if (!src.startsWith(PREFIX)) return { ok: false, reason: 'not-a-reference' };
	const rest = src.slice(PREFIX.length);
	const slash = rest.indexOf('/');
	if (slash <= 0) return { ok: false, reason: 'invalid-alias' };
	const alias = rest.slice(0, slash);
	if (!isValidAlias(alias)) return { ok: false, reason: 'invalid-alias' };
	let key: string;
	try {
		key = rest
			.slice(slash + 1)
			.split('/')
			.map((segment) => decodeURIComponent(segment))
			.join('/');
	} catch {
		return { ok: false, reason: 'invalid-encoding' };
	}
	if (checkKey(key)) return { ok: false, reason: 'invalid-key' };
	return { ok: true, value: { alias, key } };
}

/** Alt text that cannot break `![alt](url)` or trigger Obsidian's `|width` syntax. */
export function safeAltText(fileName: string): string {
	const text = fileName
		.split('')
		.map((c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? ' ' : c))
		.join('')
		.replace(/[[\]|\\`<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 100)
		.trim();
	return text === '' ? 'image' : text;
}

export function referenceMarkdown(alias: string, key: string): string {
	const name = key.split('/').pop() ?? '';
	return `![${safeAltText(name)}](${formatReference(alias, key)})`;
}
