// Object keys for uploads: tidy each variable value → expand the template → NFC → validate.
// Validation never repairs a key; it reports why the key is unusable.
import { isSha256Hex } from '../settings/history';
import type { UploadFormat } from '../settings/types';
import { extensionOf, type ImageFormat, isImageFormat } from './fileType';

export const KEY_VARIABLES = ['year', 'mon', 'day', 'filename', 'ext', 'notename', 'foldername', 'hash'] as const;
export type KeyVariable = (typeof KEY_VARIABLES)[number];

/** Variables that put note or file names into the key (and so into a public URL). */
export const IDENTIFYING_VARIABLES: readonly KeyVariable[] = ['notename', 'foldername', 'filename'];

export type KeyError = 'empty-segment' | 'dot-segment' | 'leading-slash' | 'control-char' | 'too-long';
export type TemplateError = { reason: 'unknown-variable'; name: string } | { reason: KeyError };

export type KeyResult = { ok: true; key: string } | { ok: false; reason: KeyError };
/** Templates come from synced settings too, so an unknown variable is a result, not an exception. */
export type BuildKeyResult = KeyResult | { ok: false; reason: 'unknown-variable'; name: string };

export interface KeyInput {
	/** When the upload is prepared; the device's local date is used. */
	date: Date;
	/** Vault path of the source file, e.g. `assets/画像 (1).png`. */
	sourcePath: string;
	/** Vault path of the note, e.g. `日報/2026-10-16.md`. */
	notePath: string;
	/** Format of the bytes that will be sent. `{ext}` comes from it for images, from the source name otherwise (3-2). */
	format: UploadFormat;
	/** SHA-256 (lowercase hex) of the bytes that will be sent. */
	sentSha256: string;
}

const MAX_KEY_BYTES = 1024;
const TOKEN = /\{([^{}]*)\}/g;
// eslint-disable-next-line no-control-regex -- control characters are exactly what this matches
const CONTROL = /[\u0000-\u001f\u007f]/g;
const IMAGE_EXT: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

/** Design 3-2: an image's extension follows what is sent (it may be converted); other files keep theirs, or `bin`. */
function keyExt(format: UploadFormat, sourcePath: string): string {
	return isImageFormat(format) ? IMAGE_EXT[format] : extensionOf(sourcePath) || 'bin';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

const lastSegment = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** File name without its last extension. A leading dot (`.hidden`) is not an extension. */
function stripExtension(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(0, dot) : name;
}

/** Step 1: makes a variable value safe to place inside one key segment. */
export function tidyValue(value: string): string {
	const tidy = value.normalize('NFC').replace(CONTROL, '').replace(/[/\\]/g, '_').trim();
	return tidy === '' ? '_' : tidy;
}

/** Raw variable values for one upload (before tidying). */
export function keyValues(input: KeyInput): Record<KeyVariable, string> {
	if (!isSha256Hex(input.sentSha256)) throw new Error('sentSha256 must be lowercase hex SHA-256');
	const folder = input.notePath.includes('/') ? input.notePath.slice(0, input.notePath.lastIndexOf('/')) : '';
	return {
		year: String(input.date.getFullYear()),
		mon: pad2(input.date.getMonth() + 1),
		day: pad2(input.date.getDate()),
		filename: stripExtension(lastSegment(input.sourcePath)),
		ext: keyExt(input.format, input.sourcePath),
		notename: stripExtension(lastSegment(input.notePath)),
		foldername: lastSegment(folder), // '' at the vault root, tidied to '_'
		hash: input.sentSha256.slice(0, 16),
	};
}

/** Step 4: why the key cannot be used for an upload, or undefined. */
export function checkUploadKey(key: string): KeyError | undefined {
	if (key.startsWith('/')) return 'leading-slash';
	if (new RegExp(CONTROL.source).test(key)) return 'control-char';
	const segments = key.split('/');
	if (segments.some((s) => s === '')) return 'empty-segment';
	if (segments.some((s) => s === '.' || s === '..')) return 'dot-segment';
	if (new TextEncoder().encode(key).length > MAX_KEY_BYTES) return 'too-long';
	return undefined;
}

/** Expands a template whose variable names are known (checked by checkTemplate); values are tidied here. */
export function expandTemplate(template: string, values: Record<KeyVariable, string>): KeyResult {
	const key = template.replace(TOKEN, (_, name: string) => tidyValue(values[name as KeyVariable])).normalize('NFC');
	const reason = checkUploadKey(key);
	return reason ? { ok: false, reason } : { ok: true, key };
}

const unknownVariable = (template: string) =>
	[...template.matchAll(TOKEN)].map((m) => m[1] ?? '').find((name) => !(KEY_VARIABLES as readonly string[]).includes(name));

/**
 * For saving a template: unknown variables, and structural errors that no variable value can fix
 * (checked by expanding with harmless sample values).
 */
export function checkTemplate(template: string): TemplateError | undefined {
	const name = unknownVariable(template);
	if (name !== undefined) return { reason: 'unknown-variable', name };
	const sample: Record<KeyVariable, string> = { year: '2000', mon: '01', day: '01', filename: 'f', ext: 'png', notename: 'n', foldername: 'd', hash: '0'.repeat(16) };
	const result = expandTemplate(template, sample);
	return result.ok ? undefined : { reason: result.reason };
}

/** Identifying variables used by the template (warned about for public connections). */
export function identifyingVariables(template: string): KeyVariable[] {
	const used = new Set([...template.matchAll(TOKEN)].map((m) => m[1]));
	return IDENTIFYING_VARIABLES.filter((v) => used.has(v));
}

/** Builds the object key for one upload. */
export function buildKey(template: string, input: KeyInput): BuildKeyResult {
	const name = unknownVariable(template);
	if (name !== undefined) return { ok: false, reason: 'unknown-variable', name };
	return expandTemplate(template, keyValues(input));
}

/** The fallback key used when the prepared key is taken: `-<first 8 of sentSha256>` before the last extension. */
export function alternateKey(key: string, sentSha256: string): KeyResult {
	if (!isSha256Hex(sentSha256)) throw new Error('sentSha256 must be lowercase hex SHA-256');
	const suffix = '-' + sentSha256.slice(0, 8);
	const slash = key.lastIndexOf('/');
	const dot = key.lastIndexOf('.');
	const alt = dot > slash + 1 ? key.slice(0, dot) + suffix + key.slice(dot) : key + suffix;
	const reason = checkUploadKey(alt);
	return reason ? { ok: false, reason } : { ok: true, key: alt };
}
