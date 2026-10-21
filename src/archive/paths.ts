// Design 8-1, 8-7, 8-8: the archive folder, its marker, and the paths files are moved between.

/** Design 8-1: the archive folder, at the root of the vault. */
export const ARCHIVE_FOLDER = '_s3-archive';
/** Design 8-1 (D16): a dot file, so Obsidian does not list it and it is not moved by accident. */
export const ARCHIVE_MARKER = `${ARCHIVE_FOLDER}/.vault-s3-bridge-archive.json`;
export const MARKER_FORMAT = 'vault-s3-bridge-archive';
export const MARKER_VERSION = 1;
export const MARKER_CONTENT = JSON.stringify({ format: MARKER_FORMAT, version: MARKER_VERSION });

/** valid: ours, of this version. newer: written by a later version, so not taken on. invalid: missing or broken. */
export type MarkerState = 'valid' | 'newer' | 'invalid';

export function parseMarker(text: string | undefined): MarkerState {
	if (text === undefined) return 'invalid';
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return 'invalid';
	}
	if (typeof value !== 'object' || value === null) return 'invalid';
	const { format, version } = value as { format?: unknown; version?: unknown };
	if (format !== MARKER_FORMAT || typeof version !== 'number' || !Number.isInteger(version)) return 'invalid';
	if (version > MARKER_VERSION) return 'newer';
	return version === MARKER_VERSION ? 'valid' : 'invalid';
}

/**
 * The form every path is compared in. Names may reach the plugin in another Unicode form from the file system
 * than from the vault (a Japanese name with dakuten), so paths are compared as NFC, and only ever through this.
 */
export function pathKey(path: string): string {
	return path.normalize('NFC');
}

/** Design 8-4 step 3 and 8-8: names are compared as NFC and without case. */
export function nameKey(path: string): string {
	return pathKey(path.slice(path.lastIndexOf('/') + 1)).toLowerCase();
}

export function isInArchive(path: string): boolean {
	return pathKey(path).startsWith(`${ARCHIVE_FOLDER}/`);
}

/** Design 8-7: a relative vault path with no `..`, `.` or empty segment, no leading `/` and no control character. */
export function isSafeVaultPath(path: string): boolean {
	// eslint-disable-next-line no-control-regex -- control characters are what is refused
	if (path === '' || path.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(path)) return false;
	return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Design 8-7: where a file goes, keeping its path inside the archive folder. Undefined for an unsafe path. */
export function archivedPathOf(path: string): string | undefined {
	return isSafeVaultPath(path) && !isInArchive(path) ? `${ARCHIVE_FOLDER}/${path}` : undefined;
}

/** Design 8-8: where an archived file goes back to. Undefined for the marker or an unsafe path. */
export function restoredPathOf(archived: string): string | undefined {
	if (!isInArchive(archived) || pathKey(archived) === pathKey(ARCHIVE_MARKER)) return undefined;
	const path = archived.slice(ARCHIVE_FOLDER.length + 1);
	return isSafeVaultPath(path) && !isInArchive(path) ? path : undefined;
}
